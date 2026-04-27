const { promises: dnsP, Resolver: DnsResolver } = require('node:dns');

const PLATFORM_RAILWAY_SUFFIX = 'up.railway.app';
const PLATFORM_HOST           = 'thonoscommerce.thronoschain.org';
const PUBLIC_SERVERS          = ['8.8.8.8:53', '1.1.1.1:53'];

function makePublicResolver() {
  const r = new DnsResolver();
  r.setServers(PUBLIC_SERVERS);
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
async function checkCname(domain) {
  const pairs = [
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
      if (label === 'public') {
        return { ok: false, flattenedCname: false, type: 'error', note: String(e.code || e.message), resolver: label };
      }
      // system resolver returned unexpected error — fall through to public
    }
  }
}

// Alias check (www, subdomains): CNAME is strictly required.
// Cloudflare CNAME flattening only applies at zone apex; www must have a real CNAME.
async function checkAliasCname(domain) {
  const result = await checkCname(domain);
  if (result && result.flattenedCname) {
    return { ...result, ok: false, note: 'Alias requires CNAME — A record not accepted for www/subdomain alias' };
  }
  return result;
}

// Check TXT ownership record.
// Strategy: check root domain TXT first (e.g. eukolaki.gr TXT thronos-verify=eukolakis),
// fall back to legacy subdomain TXT (_thronos-verify.eukolaki.gr).
// Try system resolver first, then public resolver.
async function checkThronosVerifyTxt(domain, tenantId) {
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

async function runDomainCheck(tenant) {
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
    checkCname(primary),
    checkThronosVerifyTxt(primary, tenant.id),
    ...aliasList.map(a => checkAliasCname(a))
  ]);

  const cname = cnameRes.status === 'fulfilled' ? cnameRes.value : { ok: false, note: cnameRes.reason?.message };
  const txt   = txtRes.status  === 'fulfilled' ? txtRes.value  : { ok: false, note: txtRes.reason?.message };
  const aliases = aliasList.map((a, i) => ({
    domain: a,
    ...(aliasRes[i].status === 'fulfilled' ? aliasRes[i].value : { ok: false, note: aliasRes[i].reason?.message })
  }));

  // Apex CNAME flattening: if Cloudflare collapsed CNAME → A, accept it when
  // TXT verification passes (TXT record proves the domain belongs to this tenant).
  const flattenedApex = cname.flattenedCname === true;
  const effectiveCnameOk = cname.ok || (flattenedApex && txt.ok);

  return {
    domain:        primary,
    checkedAt:     new Date().toISOString(),
    cnameOk:       effectiveCnameOk,
    cnameRaw:      cname.ok,
    flattenedApex,
    txtOk:         txt.ok,
    allAliasesOk:  aliases.length === 0 || aliases.every(a => a.ok),
    cname:         { ...cname, effectiveOk: effectiveCnameOk },
    txt,
    aliases
  };
}

module.exports = { checkCname, checkAliasCname, checkThronosVerifyTxt, runDomainCheck, matchesTxt, pointsToThronos };
