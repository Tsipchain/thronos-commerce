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

async function _cnameWith(resolver, domain) {
  const cnames = await resolver.resolveCname(domain);
  return { ok: pointsToThronos(cnames), cnames, type: 'cname' };
}

async function _aWith(resolver, domain) {
  try {
    const addrs = await resolver.resolve4(domain);
    return { ok: false, addrs, type: 'a', note: 'CNAME absent — A record present' };
  } catch {
    return { ok: false, type: 'nxdomain', note: 'NXDOMAIN' };
  }
}

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
        return { ok: false, type: 'error', note: String(e.code || e.message), resolver: label };
      }
      // system resolver failed non-ENODATA — try public resolver next
    }
  }
}

async function checkThronosVerifyTxt(domain, tenantId) {
  const expected = `thronos-verify=${tenantId}`;
  const pairs = [
    [dnsP, 'system'],
    [makePublicResolver(), 'public']
  ];
  for (const [r, label] of pairs) {
    try {
      const records = await r.resolveTxt(`_thronos-verify.${domain}`);
      const flat = records.flat();
      return { ok: flat.includes(expected), records: flat, expected, resolver: label };
    } catch (e) {
      if (label === 'public') {
        return { ok: false, records: [], expected, note: String(e.code || e.message), resolver: label };
      }
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

  const [cnameRes, txtRes, ...aliasRes] = await Promise.allSettled([
    checkCname(primary),
    checkThronosVerifyTxt(primary, tenant.id),
    ...aliasList.map(a => checkCname(a))
  ]);

  const cname   = cnameRes.status === 'fulfilled' ? cnameRes.value : { ok: false, note: cnameRes.reason?.message };
  const txt     = txtRes.status  === 'fulfilled' ? txtRes.value  : { ok: false, note: txtRes.reason?.message };
  const aliases = aliasList.map((a, i) => ({
    domain: a,
    ...(aliasRes[i].status === 'fulfilled' ? aliasRes[i].value : { ok: false, note: aliasRes[i].reason?.message })
  }));

  return {
    domain:       primary,
    checkedAt:    new Date().toISOString(),
    cnameOk:      cname.ok,
    txtOk:        txt.ok,
    allAliasesOk: aliases.length === 0 || aliases.every(a => a.ok),
    cname,
    txt,
    aliases
  };
}

module.exports = { checkCname, checkThronosVerifyTxt, runDomainCheck };
