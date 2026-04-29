const axios = require('axios');

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT = 10000;

class CloudflareClient {
  constructor(apiToken) {
    if (!apiToken) throw new Error('Cloudflare API token is required');
    this.apiToken = apiToken;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json'
    };
  }

  async _get(path, params = {}) {
    const resp = await axios.get(`${CF_BASE}${path}`, {
      headers: this._headers(),
      params,
      timeout: REQUEST_TIMEOUT
    });
    if (!resp.data.success) {
      const msg = (resp.data.errors || []).map(e => e.message).join('; ');
      throw new Error(`Cloudflare API error: ${msg}`);
    }
    return resp.data;
  }

  async _post(path, body) {
    const resp = await axios.post(`${CF_BASE}${path}`, body, {
      headers: this._headers(),
      timeout: REQUEST_TIMEOUT
    });
    if (!resp.data.success) {
      const msg = (resp.data.errors || []).map(e => e.message).join('; ');
      throw new Error(`Cloudflare API error: ${msg}`);
    }
    return resp.data;
  }

  async _put(path, body) {
    const resp = await axios.put(`${CF_BASE}${path}`, body, {
      headers: this._headers(),
      timeout: REQUEST_TIMEOUT
    });
    if (!resp.data.success) {
      const msg = (resp.data.errors || []).map(e => e.message).join('; ');
      throw new Error(`Cloudflare API error: ${msg}`);
    }
    return resp.data;
  }

  async _delete(path) {
    const resp = await axios.delete(`${CF_BASE}${path}`, {
      headers: this._headers(),
      timeout: REQUEST_TIMEOUT
    });
    if (!resp.data.success) {
      const msg = (resp.data.errors || []).map(e => e.message).join('; ');
      throw new Error(`Cloudflare API error: ${msg}`);
    }
    return resp.data;
  }

  // Look up zone ID for a domain (searches by apex domain name)
  async lookupZoneId(domain) {
    const apex = domain.split('.').slice(-2).join('.');
    const data = await this._get('/zones', { name: apex, status: 'active' });
    if (!data.result || data.result.length === 0) {
      throw new Error(`No active Cloudflare zone found for domain: ${apex}`);
    }
    return data.result[0].id;
  }

  // List DNS records in a zone, optionally filtered by name and/or type
  async listDnsRecords(zoneId, { name, type } = {}) {
    const params = {};
    if (name) params.name = name;
    if (type) params.type = type;
    const data = await this._get(`/zones/${zoneId}/dns_records`, params);
    return data.result || [];
  }

  // Create a DNS record
  async createDnsRecord(zoneId, { type, name, content, ttl = 1, proxied = false }) {
    const data = await this._post(`/zones/${zoneId}/dns_records`, {
      type,
      name,
      content,
      ttl,
      proxied
    });
    return data.result;
  }

  // Update an existing DNS record by record ID
  async updateDnsRecord(zoneId, recordId, { type, name, content, ttl = 1, proxied = false }) {
    const data = await this._put(`/zones/${zoneId}/dns_records/${recordId}`, {
      type,
      name,
      content,
      ttl,
      proxied
    });
    return data.result;
  }

  // Delete a DNS record
  async deleteDnsRecord(zoneId, recordId) {
    return this._delete(`/zones/${zoneId}/dns_records/${recordId}`);
  }

  // Get zone nameservers (used for authoritative DNS queries)
  async getZoneNameservers(zoneId) {
    const data = await this._get(`/zones/${zoneId}`);
    return (data.result && data.result.name_servers) || [];
  }

  // List all DNS records for a zone as a keyed map: { 'TYPE:name': record[] }
  async listAllRecords(zoneId) {
    const records = await this.listDnsRecords(zoneId);
    const map = {};
    for (const r of records) {
      const key = `${r.type}:${r.name}`;
      if (!map[key]) map[key] = [];
      map[key].push(r);
    }
    return map;
  }

  // Idempotent upsert: create if missing, update if content differs, no-op if identical.
  // Returns { action: 'created'|'updated'|'noop', record }
  async upsertDnsRecord(zoneId, { type, name, content, ttl = 1, proxied = false }) {
    const existing = await this.listDnsRecords(zoneId, { type, name });
    const match = existing.find(r => r.name === name && r.type === type);

    if (!match) {
      const created = await this.createDnsRecord(zoneId, { type, name, content, ttl, proxied });
      return { action: 'created', record: created };
    }
    if (match.content === content && match.proxied === proxied) {
      return { action: 'noop', record: match };
    }
    const updated = await this.updateDnsRecord(zoneId, match.id, { type, name, content, ttl, proxied });
    return { action: 'updated', record: updated };
  }

  // Sync all required DNS records for a tenant domain idempotently.
  // requiredRecords: array of { type, name, content, proxied? }
  // Returns array of { action, record } results
  async syncDnsRecords(zoneId, requiredRecords) {
    const results = [];
    for (const rec of requiredRecords) {
      const result = await this.upsertDnsRecord(zoneId, rec);
      results.push({ ...result, input: rec });
    }
    return results;
  }

  // High-level: build and sync the required DNS records for a tenant.
  // primaryDomain: 'eukolaki.gr'
  // aliases: ['www.eukolaki.gr']
  // tenantId: 'eukolakis'
  // railwayTargets: { 'eukolaki.gr': 'olz9lkef.up.railway.app', 'www.eukolaki.gr': 'b2el3wfs.up.railway.app' }
  // railwayVerifyTokens: { 'www.eukolaki.gr': 'railway-verify=abc...' }  (for _railway-verify.<alias>)
  async syncTenantDnsRecords(zoneId, { primaryDomain, aliases, tenantId, railwayTargets = {}, railwayVerifyTokens = {} }) {
    const required = [];

    // Apex CNAME (or proxied CNAME → Cloudflare auto-flattens to A at apex)
    const apexTarget = railwayTargets[primaryDomain];
    if (apexTarget) {
      required.push({ type: 'CNAME', name: primaryDomain, content: apexTarget, proxied: true });
    }

    // TXT ownership verification at apex
    required.push({
      type: 'TXT',
      name: primaryDomain,
      content: `thronos-verify=${tenantId}`,
      ttl: 1,
      proxied: false
    });

    // Alias CNAMEs + railway-verify TXT records
    for (const alias of (aliases || [])) {
      const aliasTarget = railwayTargets[alias];
      if (aliasTarget) {
        required.push({ type: 'CNAME', name: alias, content: aliasTarget, proxied: true });
      }
      const verifyToken = railwayVerifyTokens[alias];
      if (verifyToken) {
        // _railway-verify.<alias>  TXT  "railway-verify=<token>"
        const verifyName = `_railway-verify.${alias}`;
        required.push({ type: 'TXT', name: verifyName, content: verifyToken, ttl: 1, proxied: false });
      }
    }

    return this.syncDnsRecords(zoneId, required);
  }

  // Read records for a domain from Cloudflare (authoritative truth).
  // Returns structured result matching runDomainCheck output format.
  async readTenantDnsState(zoneId, { primaryDomain, aliases, tenantId, canonicalHost = 'apex' }) {
    const allAliases = aliases || [];
    const canonicalDomain = canonicalHost === 'www' ? `www.${primaryDomain}` : primaryDomain;
    const requiredAliases = canonicalHost === 'www'
      ? allAliases.filter(a => a !== canonicalDomain)
      : allAliases;
    const allDomains = [primaryDomain, canonicalDomain, ...requiredAliases];

    // Fetch all records for each domain
    const recordsByDomain = {};
    await Promise.all(allDomains.map(async domain => {
      recordsByDomain[domain] = await this.listDnsRecords(zoneId, { name: domain });
    }));

    // Also fetch _railway-verify records for aliases
    const railwayVerifyRecords = {};
    await Promise.all(requiredAliases.map(async alias => {
      const verifyName = `_railway-verify.${alias}`;
      try {
        const recs = await this.listDnsRecords(zoneId, { name: verifyName });
        railwayVerifyRecords[alias] = recs;
      } catch (e) {
        railwayVerifyRecords[alias] = [];
      }
    }));

    // Also fetch TXT for apex
    const apexTxt = recordsByDomain[primaryDomain].filter(r => r.type === 'TXT');
    const thronosToken = `thronos-verify=${tenantId}`;
    const txtOk = apexTxt.some(r => r.content === thronosToken);

    // Check apex records
    const apexCname = recordsByDomain[primaryDomain].filter(r => r.type === 'CNAME');
    const apexA = recordsByDomain[primaryDomain].filter(r => r.type === 'A');
    const PLATFORM_RAILWAY_SUFFIX = 'up.railway.app';
    const apexRailwayCnameOk = apexCname.some(r => r.content.endsWith(PLATFORM_RAILWAY_SUFFIX) || r.content.endsWith('.thronoschain.org'));
    const flattenedApex = apexCname.length === 0 && apexA.length > 0;
    const apexPlaceholderOk = apexA.some(r => r.proxied === true && r.content === '192.0.2.1');

    const canonicalRecords = recordsByDomain[canonicalDomain] || [];
    const canonicalCname = canonicalRecords.filter(r => r.type === 'CNAME');
    const canonicalCnameOk = canonicalCname.some(r => r.content.endsWith(PLATFORM_RAILWAY_SUFFIX) || r.content.endsWith('.thronoschain.org'));

    // Check aliases
    const aliasResults = requiredAliases.map(alias => {
      const recs = recordsByDomain[alias] || [];
      const aliasCname = recs.filter(r => r.type === 'CNAME');
      const aliasOk = aliasCname.some(r => r.content.endsWith(PLATFORM_RAILWAY_SUFFIX) || r.content.endsWith('.thronoschain.org'));
      const railwayVerify = (railwayVerifyRecords[alias] || []).filter(r => r.type === 'TXT');
      return {
        domain: alias,
        ok: aliasOk,
        cnames: aliasCname.map(r => r.content),
        railwayVerifyOk: railwayVerify.length > 0,
        source: 'cloudflare-api'
      };
    });

    const effectiveCnameOk = canonicalHost === 'www'
      ? canonicalCnameOk
      : (apexRailwayCnameOk || (flattenedApex && txtOk));
    const apexDnsStatus = canonicalHost === 'www'
      ? (apexPlaceholderOk ? 'proxied_placeholder_ok' : 'missing_placeholder_warning')
      : (flattenedApex ? 'flattened_or_apex_a' : (apexRailwayCnameOk ? 'railway_target_ok' : 'missing'));

    return {
      source: 'cloudflare-api',
      domain: primaryDomain,
      canonicalHost,
      canonicalDomain,
      apexMode: canonicalHost === 'www' ? 'redirect_to_www' : 'direct_to_platform',
      apexDnsStatus,
      apexPlaceholderOk,
      cnameOk: effectiveCnameOk,
      cnameRaw: canonicalHost === 'www' ? canonicalCnameOk : apexRailwayCnameOk,
      flattenedApex,
      txtOk,
      allAliasesOk: aliasResults.length === 0 || aliasResults.every(a => a.ok),
      apexCnames: apexCname.map(r => r.content),
      apexAddresses: apexA.map(r => r.content),
      apexTxtRecords: apexTxt.map(r => r.content),
      aliases: aliasResults
    };
  }
}

// Get a Cloudflare client for a tenant.
// Uses per-tenant API token if set (tenant.hosting.cloudflareApiToken),
// falls back to global env CLOUDFLARE_API_TOKEN.
// Never uses a global CLOUDFLARE_ZONE_ID.
function getCloudflareClient(tenant) {
  const hosting = (tenant && tenant.hosting) || {};
  const token = hosting.cloudflareApiToken || process.env.CLOUDFLARE_API_TOKEN || '';
  if (!token) return null;
  try {
    return new CloudflareClient(token);
  } catch (e) {
    return null;
  }
}

// Get the zone ID for a tenant. Only from per-tenant config, never global env.
function getTenantZoneId(tenant) {
  const hosting = (tenant && tenant.hosting) || {};
  return (hosting.cloudflareZoneId || '').trim() || null;
}

module.exports = { CloudflareClient, getCloudflareClient, getTenantZoneId };
