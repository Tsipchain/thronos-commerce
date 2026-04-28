const { promises: dnsP, Resolver: DnsResolver } = require('node:dns');

const PLATFORM_RAILWAY_SUFFIX = 'up.railway.app';
const PLATFORM_HOST           = 'thonoscommerce.thronoschain.org';
const PUBLIC_SERVERS          = ['8.8.8.8:53', '1.1.1.1:53'];

function makePublicResolver() {
  const r = new DnsResolver();
  r.setServers(PUBLIC_SERVERS);
  return r;
}

function makeCustomResolver(servers) {
  const r = new DnsResolver();
  r.setServers(servers);
  return r;
}

function pointsToThronos(cnames) {
  return cnames.some(
    c => c.endsWith(PLATFORM_RAILWAY_SUFFIX) || c === PLATFORM_HOST || c.endsWith('.thronoschain.org')
  );
}

// Pure: check if a flat TXT records array contains the expected token.
function matchesTxt(records, tenantId) {
  const expected = `thronos-verify=${tenantId}`;
  if (!Array.isArray(records)) return false;
  return records.flat().includes(expected);
}

async function _cnameWith(resolver, domain) {
  const cnames = await resolver.resolveCname(domain);
  return { ok: pointsToThronos(cnames), cnames, type: 'cname' };
}

async function _aWith(resolver, domain) {
  try {
    const addrs = await resolver.resolve4(domain);
    // flattenedCname: Cloudflare and some DNS providers collapse the CNAME at the
    // zone apex into A records (RFC 1034 §3.6.2 forbids CNAME at apex alongside
    // other records, so providers synthesise A records instead).
    return { ok: false, flattenedCname: true, addrs, type: 'apex-a', note: 'CNAME absent — A record present (possible Cloudflare CNAME flattening)' };
  } catch {
    return { ok: false, flattenedCname: false, type: 'nxdomain', note: 'NXDOMAIN' };
  }
}

// Check a domain for CNAME → Thronos target.
// For apex/primary domains a flattened CNAME (A record) may be returned;
// callers should treat flattenedCname=true as conditional-ok based on TXT.
async function checkCname(domain, resolverOverride) {
  const pairs = resolverOverride
    ? [[resolverOverride, 'custom']]
    : [
        [dnsP, 'system'],
        [makePublicResolver(), 'public']
      ];
  for (const [r, label] of pairs) {
    try {
      return { ...(await _cnameWith(r, domain)), resolver: label };
    } catch (e) {
      if (e.code === 'ENODATA' || e.code === 'ENOTFOUND') {
        return { ...(await _aWith(r, domain)), resolver: label };
      }
      if (label === 'public' || label === 'custom') {
        return { ok: false, flattenedCname: false, type: 'error', note: String(e.code || e.message), resolver: label };
      }
      // system resolver returned unexpected error — fall through to public
    }
  }
}

// Alias check (www, subdomains): CNAME is strictly required.
// Cloudflare CNAME flattening only applies at zone apex; www must have a real CNAME.
async function checkAliasCname(domain, resolverOverride) {
  const result = await checkCname(domain, resolverOverride);
  if (result && result.flattenedCname) {
    return { ...result, ok: false, note: 'Alias requires CNAME — A record not accepted for www/subdomain alias' };
  }
  return result;
}

// Check TXT ownership record.
// Strategy: check root domain TXT first (e.g. eukolaki.gr TXT thronos-verify=eukolakis),
// fall back to legacy subdomain TXT (_thronos-verify.eukolaki.gr).
// Try system resolver first, then public resolver.
async function checkThronosVerifyTxt(domain, tenantId, resolverOverride) {
  const expected = `thronos-verify=${tenantId}`;

  async function tryRootThenLegacy(resolver, label) {
    // 1. Root domain TXT (e.g. eukolaki.gr  TXT  "thronos-verify=eukolakis")
    try {
      const records = await resolver.resolveTxt(domain);
      const flat = records.flat();
      if (flat.includes(expected)) {
        return { ok: true, records: flat, expected, resolver: label, source: 'root' };
      }
      // TXT records exist but our token not found — fall through to legacy
    } catch (e) {
      const ignorable = new Set(['ENODATA', 'ENOTFOUND', 'ESERVFAIL', 'ETIMEOUT']);
      if (!ignorable.has(e.code)) throw e;
    }

    // 2. Legacy: _thronos-verify.<domain>  TXT  "thronos-verify=eukolakis"
    try {
      const records = await resolver.resolveTxt(`_thronos-verify.${domain}`);
      const flat = records.flat();
      return {
        ok: flat.includes(expected),
        records: flat,
        expected,
        resolver: label,
        source: 'legacy_subdomain'
      };
    } catch (e) {
      return { ok: false, records: [], expected, resolver: label, source: 'not_found', note: String(e.code || e.message) };
    }
  }

  if (resolverOverride) {
    return tryRootThenLegacy(resolverOverride, 'custom');
  }

  const pairs = [[dnsP, 'system'], [makePublicResolver(), 'public']];
  for (const [r, label] of pairs) {
    try {
      return await tryRootThenLegacy(r, label);
    } catch (e) {
      if (label === 'public') {
        return { ok: false, records: [], expected, resolver: label, source: 'error', note: String(e.code || e.message) };
      }
      // system had unexpected error — try public
    }
  }
}

// Helper: get actual CNAME targets for a domain (returns { targets, type, addresses }).
async function getAliasCnameTargets(domain) {
  const resolver = makePublicResolver();
  try {
    const cnames = await resolver.resolveCname(domain);
    return { targets: cnames, type: 'cname', addresses: null };
  } catch (e) {
    if (e.code === 'ENODATA' || e.code === 'ENOTFOUND') {
      try {
        const addrs = await resolver.resolve4(domain);
        return { targets: null, type: 'a-record', addresses: addrs };
      } catch { }
    }
    return { targets: null, type: 'error', addresses: null, note: String(e.code || e.message) };
  }
}

// Helper: get TXT records for a domain (including legacy subdomain).
async function getTxtRecords(domain) {
  const resolver = makePublicResolver();
  const results = { root: null, legacy: null };

  try {
    results.root = (await resolver.resolveTxt(domain)).flat();
  } catch (e) {
    // ENODATA is normal if TXT doesn't exist
  }

  try {
    results.legacy = (await resolver.resolveTxt(`_thronos-verify.${domain}`)).flat();
  } catch (e) {
    // ENODATA is normal if legacy TXT doesn't exist
  }

  return results;
}

// Helper: get A records for apex domain (used when CNAME is flattened).
async function checkApexA(domain) {
  const resolver = makePublicResolver();
  try {
    const addrs = await resolver.resolve4(domain);
    return { addresses: addrs, type: 'a-record' };
  } catch (e) {
    return { addresses: null, type: 'error', note: String(e.code || e.message) };
  }
}

// Core domain check using a specific resolver (or default public+system)
async function _runDomainCheckWithResolver(tenant, resolverOverride) {
  const primary = String(tenant.primaryDomain || tenant.domain || '').trim().toLowerCase();
  if (!primary) {
    return { domain: null, cnameOk: false, txtOk: false, checkedAt: new Date().toISOString() };
  }
  const aliasList = (Array.isArray(tenant.domains) ? tenant.domains : [])
    .map(d => String(d).trim().toLowerCase())
    .filter(Boolean);

  // Primary apex: checkCname (flattenedCname allowed, evaluated below)
  // Aliases (www etc.): checkAliasCname (flattenedCname = fail)
  const [cnameRes, txtRes, ...aliasRes] = await Promise.allSettled([
    checkCname(primary, resolverOverride),
    checkThronosVerifyTxt(primary, tenant.id, resolverOverride),
    ...aliasList.map(a => checkAliasCname(a, resolverOverride))
  ]);

  const cname = cnameRes.status === 'fulfilled' ? cnameRes.value : { ok: false, note: cnameRes.reason?.message };
  const txt   = txtRes.status  === 'fulfilled' ? txtRes.value  : { ok: false, note: txtRes.reason?.message };
  const aliases = aliasList.map((a, i) => ({
    domain: a,
    ...(aliasRes[i].status === 'fulfilled' ? aliasRes[i].value : { ok: false, note: aliasRes[i].reason?.message })
  }));

  const flattenedApex = cname.flattenedCname === true;
  const effectiveCnameOk = cname.ok || (flattenedApex && txt.ok);

  return {
    domain:       primary,
    checkedAt:    new Date().toISOString(),
    cnameOk:      effectiveCnameOk,
    cnameRaw:     cname.ok,
    flattenedApex,
    txtOk:        txt.ok,
    allAliasesOk: aliases.length === 0 || aliases.every(a => a.ok),
    cname:        { ...cname, effectiveOk: effectiveCnameOk },
    txt,
    aliases
  };
}

// Standard check: public resolvers only (1.1.1.1, 8.8.8.8, system)
async function runDomainCheck(tenant) {
  const primary = String(tenant.primaryDomain || tenant.domain || '').trim().toLowerCase();
  if (!primary) {
    return { domain: null, cnameOk: false, txtOk: false, checkedAt: new Date().toISOString() };
  }
  const aliasList = (Array.isArray(tenant.domains) ? tenant.domains : [])
    .map(d => String(d).trim().toLowerCase())
    .filter(Boolean);

  const base = await _runDomainCheckWithResolver(tenant, null);

  // Build required vs detected records structure
  const requiredRecords = {
    apex: {
      type: 'CNAME',
      target: PLATFORM_RAILWAY_SUFFIX,
      description: 'Primary domain must point to Thronos Railway deployment'
    },
    txt: {
      type: 'TXT',
      location: primary,
      value: `thronos-verify=${tenant.id}`,
      description: 'Ownership verification record'
    },
    aliases: aliasList.length > 0 ? aliasList.map(domain => ({
      domain,
      type: 'CNAME',
      target: PLATFORM_RAILWAY_SUFFIX,
      description: 'Alias must have real CNAME to Thronos'
    })) : []
  };

  const cname = base.cname;
  const txt = base.txt;
  const aliases = base.aliases;

  const detectedRecords = {
    apex: cname.cnames ? {
      type: 'CNAME',
      targets: cname.cnames,
      verified: cname.effectiveOk || base.cnameOk
    } : cname.flattenedCname ? {
      type: 'A-record',
      addresses: cname.addrs || [],
      verified: false,
      note: 'CNAME flattened to A records (will verify if TXT passes)'
    } : {
      type: 'error',
      verified: false,
      note: cname.note || 'Could not resolve'
    },
    txt: txt.records ? {
      location: txt.source || 'unknown',
      value: txt.records.find(r => r.includes('thronos-verify')) || (txt.records.length > 0 ? txt.records[0] : null),
      allValues: txt.records,
      verified: txt.ok
    } : {
      verified: false,
      note: txt.note || 'No TXT records found'
    },
    aliases: aliases.length > 0 ? aliases.map(a => ({
      domain: a.domain,
      type: a.cnames ? 'CNAME' : a.flattenedCname ? 'A-record' : 'error',
      targets: a.cnames || [],
      addresses: a.addrs || [],
      verified: a.ok,
      note: a.note
    })) : []
  };

  return { ...base, requiredRecords, detectedRecords };
}

// Full check: public resolvers + optionally Cloudflare authoritative API.
// Returns both public and authoritative (CF API) results separately.
// propagationStatus: 'ok' | 'propagating' | 'missing' | 'unknown'
//   - ok:          public resolvers show correct records
//   - propagating: CF API shows correct records but public resolvers haven't caught up yet
//   - missing:     CF API shows records are missing or wrong
//   - unknown:     no CF zone configured, only public check available
async function runDomainCheckFull(tenant) {
  const publicResult = await runDomainCheck(tenant);
  const publicAllOk = publicResult.cnameOk && publicResult.txtOk && publicResult.allAliasesOk;

  // Try Cloudflare API authoritative check if zone is configured
  let authResult = null;
  let authAllOk = null;
  let cfError = null;

  const hosting = (tenant && tenant.hosting) || {};
  const zoneId = (hosting.cloudflareZoneId || '').trim();
  const cfToken = (hosting.cloudflareApiToken || '').trim() || process.env.CLOUDFLARE_API_TOKEN || '';

  if (zoneId && cfToken) {
    try {
      const { CloudflareClient } = require('./cloudflare-api');
      const cf = new CloudflareClient(cfToken);
      authResult = await cf.readTenantDnsState(zoneId, {
        primaryDomain: tenant.primaryDomain || tenant.domain,
        aliases: tenant.domains || [],
        tenantId: tenant.id
      });
      authResult.source = 'cloudflare-api';
      authAllOk = authResult.cnameOk && authResult.txtOk && authResult.allAliasesOk;
    } catch (e) {
      cfError = e.message;
      authResult = null;
    }
  }

  // Determine propagation status
  let propagationStatus;
  if (authResult) {
    if (authAllOk && publicAllOk) {
      propagationStatus = 'ok';
    } else if (authAllOk && !publicAllOk) {
      propagationStatus = 'propagating'; // CF correct, public resolvers stale
    } else {
      propagationStatus = 'missing'; // CF config missing/wrong
    }
  } else {
    propagationStatus = publicAllOk ? 'ok' : 'unknown';
  }

  return {
    ...publicResult,
    public: {
      cnameOk: publicResult.cnameOk,
      txtOk: publicResult.txtOk,
      allAliasesOk: publicResult.allAliasesOk,
      cname: publicResult.cname,
      txt: publicResult.txt,
      aliases: publicResult.aliases
    },
    authoritative: authResult,
    authoritativeOk: authAllOk,
    propagationStatus,
    cfError: cfError || null,
    hasCloudflareZone: !!(zoneId && cfToken)
  };
}

module.exports = {
  checkCname,
  checkAliasCname,
  checkThronosVerifyTxt,
  runDomainCheck,
  runDomainCheckFull,
  matchesTxt,
  pointsToThronos,
  getAliasCnameTargets,
  getTxtRecords,
  checkApexA
};
