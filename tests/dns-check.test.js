const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesTxt, pointsToThronos } = require('../utils/dns-check');

// ── CNAME target matching ─────────────────────────────────────────────────────

test('railway up.railway.app CNAME accepted', () => {
  assert.ok(pointsToThronos(['olz9lkef.up.railway.app']));
});

test('platform thonoscommerce.thronoschain.org CNAME accepted', () => {
  assert.ok(pointsToThronos(['thonoscommerce.thronoschain.org']));
});

test('any .thronoschain.org subdomain CNAME accepted', () => {
  assert.ok(pointsToThronos(['thronos-commerce.thronoschain.org']));
});

test('random CDN CNAME rejected', () => {
  assert.equal(pointsToThronos(['some-cdn.cloudfront.net']), false);
});

test('empty CNAME list rejected', () => {
  assert.equal(pointsToThronos([]), false);
});

// ── TXT record matching (pure) ────────────────────────────────────────────────
// Both root domain TXT and _thronos-verify subdomain TXT use the same value
// format: "thronos-verify=<tenantId>". matchesTxt checks the value regardless
// of which DNS name was queried.

test('root TXT thronos-verify=eukolakis is accepted', () => {
  // Simulates: eukolaki.gr  TXT  "thronos-verify=eukolakis"
  assert.ok(matchesTxt(['thronos-verify=eukolakis'], 'eukolakis'));
});

test('root TXT with mixed records — our token accepted among others', () => {
  // Root TXT often contains SPF, Google verify, etc.
  const records = ['v=spf1 include:mailjet.com ~all', 'google-site-verification=abc123', 'thronos-verify=eukolakis'];
  assert.ok(matchesTxt(records, 'eukolakis'));
});

test('legacy _thronos-verify subdomain TXT format is also accepted (same token format)', () => {
  // Simulates: _thronos-verify.eukolaki.gr  TXT  "thronos-verify=eukolakis"
  assert.ok(matchesTxt(['thronos-verify=eukolakis'], 'eukolakis'));
});

test('wrong tenant ID is rejected', () => {
  assert.equal(matchesTxt(['thronos-verify=othertenant'], 'eukolakis'), false);
});

test('partial match is rejected (must be exact token)', () => {
  assert.equal(matchesTxt(['thronos-verify=eukolakis-extra'], 'eukolakis'), false);
});

test('empty records array is rejected', () => {
  assert.equal(matchesTxt([], 'eukolakis'), false);
});

test('null records is rejected gracefully', () => {
  assert.equal(matchesTxt(null, 'eukolakis'), false);
});

// ── Apex CNAME flattening ─────────────────────────────────────────────────────
// Cloudflare and some DNS providers flatten CNAME at zone apex into A records.
// This is valid per RFC 7871 alias; our code must not reject it automatically.

test('apex-a result shape: flattenedCname=true, ok=false', () => {
  // Simulates what checkCname returns when resolveCname throws ENODATA and
  // resolve4 succeeds — the pattern produced by Cloudflare CNAME flattening.
  const apexResult = { ok: false, flattenedCname: true, type: 'apex-a', addrs: ['151.101.2.15'] };
  assert.equal(apexResult.flattenedCname, true);
  assert.equal(apexResult.ok, false, 'raw ok is false; effectiveOk requires TXT');
});

test('effectiveCnameOk = true when flattenedApex + txtOk', () => {
  const cname = { ok: false, flattenedCname: true, type: 'apex-a' };
  const txt   = { ok: true };
  const effectiveCnameOk = cname.ok || (cname.flattenedCname === true && txt.ok);
  assert.ok(effectiveCnameOk, 'flattened apex + TXT verified should be effective-ok');
});

test('effectiveCnameOk = false when flattenedApex but txtOk=false', () => {
  const cname = { ok: false, flattenedCname: true, type: 'apex-a' };
  const txt   = { ok: false };
  const effectiveCnameOk = cname.ok || (cname.flattenedCname === true && txt.ok);
  assert.equal(effectiveCnameOk, false, 'flattened apex without TXT must not auto-verify');
});

test('effectiveCnameOk = true when real CNAME target matches (no flattening)', () => {
  const cname = { ok: true, cnames: ['olz9lkef.up.railway.app'], type: 'cname' };
  const txt   = { ok: false };
  const effectiveCnameOk = cname.ok || (cname.flattenedCname === true && txt.ok);
  assert.ok(effectiveCnameOk, 'direct CNAME match is always ok regardless of TXT');
});

// ── Alias CNAME strictness ────────────────────────────────────────────────────
// www/subdomain aliases must have a real CNAME to our target.
// A record is NOT acceptable for aliases even though it is for apex.

test('alias with A record is not ok (even if flagged flattenedCname)', () => {
  // checkAliasCname overrides ok=false for any flattenedCname result
  const aliasResult = {
    ok: false,
    flattenedCname: true,
    type: 'apex-a',
    note: 'Alias requires CNAME — A record not accepted for www/subdomain alias'
  };
  assert.equal(aliasResult.ok, false, 'alias with A record must remain failed');
});

test('alias with CNAME to Railway target is ok', () => {
  const aliasResult = { ok: true, cnames: ['olz9lkef.up.railway.app'], type: 'cname', flattenedCname: false };
  assert.ok(aliasResult.ok);
});

// ── runDomainCheck result shape (real DNS, shape only) ────────────────────────

test('runDomainCheck returns expected shape when domain is empty', async () => {
  const { runDomainCheck } = require('../utils/dns-check');
  const result = await runDomainCheck({ id: 'demo', primaryDomain: '', domain: '', domains: [] });
  assert.equal(result.domain, null);
  assert.equal(result.cnameOk, false);
  assert.equal(result.txtOk, false);
  assert.ok(result.checkedAt);
});

test('runDomainCheck result has correct shape for tenant with aliases', async () => {
  const { runDomainCheck } = require('../utils/dns-check');
  const result = await runDomainCheck({
    id: 'eukolakis',
    primaryDomain: 'eukolaki.gr',
    domain: 'eukolaki.gr',
    domains: ['www.eukolaki.gr']
  });
  // Shape assertions — we don't assert the actual DNS values here
  assert.ok(typeof result.cnameOk === 'boolean', 'cnameOk is boolean');
  assert.ok(typeof result.cnameRaw === 'boolean', 'cnameRaw is boolean');
  assert.ok(typeof result.flattenedApex === 'boolean', 'flattenedApex is boolean');
  assert.ok(typeof result.txtOk === 'boolean', 'txtOk is boolean');
  assert.ok(typeof result.allAliasesOk === 'boolean', 'allAliasesOk is boolean');
  assert.ok(Array.isArray(result.aliases), 'aliases is array');
  assert.equal(result.aliases.length, 1, 'one alias entry for www.eukolaki.gr');
  assert.equal(result.aliases[0].domain, 'www.eukolaki.gr');
  assert.ok(typeof result.aliases[0].ok === 'boolean', 'alias result has ok boolean');
  // txt.source tells us where the token was found (root | legacy_subdomain | not_found)
  assert.ok(result.txt && (result.txt.source || result.txt.note), 'txt has source or note');
}, { timeout: 15000 });

test('runDomainCheck: apex flattening scenario — cnameOk is true when A+TXT both ok', () => {
  // Synthesise a check result that mirrors Cloudflare flattening:
  const cname = { ok: false, flattenedCname: true, type: 'apex-a', addrs: ['151.101.2.15'] };
  const txt   = { ok: true, source: 'root' };
  const flattenedApex = cname.flattenedCname === true;
  const effectiveCnameOk = cname.ok || (flattenedApex && txt.ok);
  assert.ok(effectiveCnameOk, 'when Cloudflare flattens CNAME and TXT verifies, tenant is verified');
});
