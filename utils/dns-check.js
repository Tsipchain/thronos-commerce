const dns = require('node:dns').promises;

const PLATFORM_RAILWAY_SUFFIX = 'up.railway.app';
const PLATFORM_HOST = 'thonoscommerce.thronoschain.org';

async function checkCname(domain) {
  try {
    const cnames = await dns.resolveCname(domain);
    const pointsToRailway = cnames.some(
      c => c.endsWith(PLATFORM_RAILWAY_SUFFIX) || c === PLATFORM_HOST || c.endsWith('.thronoschain.org')
    );
    return { ok: pointsToRailway, cnames, type: 'cname' };
  } catch (e) {
    if (e.code === 'ENODATA' || e.code === 'ENOTFOUND') {
      try {
        const addrs = await dns.resolve4(domain);
        return { ok: false, addrs, type: 'a', note: 'CNAME absent — A record present' };
      } catch {
        return { ok: false, type: 'nxdomain', note: String(e.code || e.message) };
      }
    }
    return { ok: false, type: 'error', note: String(e.code || e.message) };
  }
}

async function checkThronosVerifyTxt(domain, tenantId) {
  try {
    const records = await dns.resolveTxt(`_thronos-verify.${domain}`);
    const flat = records.flat();
    const expected = `thronos-verify=${tenantId}`;
    return { ok: flat.includes(expected), records: flat, expected };
  } catch (e) {
    return { ok: false, records: [], expected: `thronos-verify=${tenantId}`, note: String(e.code || e.message) };
  }
}

async function runDomainCheck(tenant) {
  const domain = String(tenant.primaryDomain || tenant.domain || '').trim().toLowerCase();
  if (!domain) return { domain: null, cnameOk: false, txtOk: false, checkedAt: new Date().toISOString() };

  const [cnameRes, txtRes] = await Promise.allSettled([
    checkCname(domain),
    checkThronosVerifyTxt(domain, tenant.id)
  ]);

  const cname = cnameRes.status === 'fulfilled' ? cnameRes.value : { ok: false, note: cnameRes.reason?.message };
  const txt   = txtRes.status  === 'fulfilled' ? txtRes.value  : { ok: false, note: txtRes.reason?.message };

  return {
    domain,
    checkedAt: new Date().toISOString(),
    cnameOk: cname.ok,
    txtOk: txt.ok,
    cname,
    txt
  };
}

module.exports = { checkCname, checkThronosVerifyTxt, runDomainCheck };
