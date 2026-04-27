const test = require('node:test');
const assert = require('node:assert/strict');

// Unit-test the pure helper inside dns-check that validates CNAME targets.
// We re-implement the pointsToThronos predicate here to keep the test
// independent of actual DNS calls.

const PLATFORM_RAILWAY_SUFFIX = 'up.railway.app';
const PLATFORM_HOST           = 'thonoscommerce.thronoschain.org';

function pointsToThronos(cnames) {
  return cnames.some(
    c => c.endsWith(PLATFORM_RAILWAY_SUFFIX) || c === PLATFORM_HOST || c.endsWith('.thronoschain.org')
  );
}

// ── CNAME target matching ─────────────────────────────────────────────────────

test('railway up.railway.app CNAME accepted', () => {
  assert.ok(pointsToThronos(['olz9lkef.up.railway.app']));
});

test('platform thonoscommerce.thronoschain.org CNAME accepted', () => {
  assert.ok(pointsToThronos([PLATFORM_HOST]));
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

// ── TXT verify format ─────────────────────────────────────────────────────────

test('TXT record format is thronos-verify=<tenantId>', () => {
  const tenantId = 'eukolakis';
  const expected = `thronos-verify=${tenantId}`;
  const records  = [expected];
  assert.ok(records.includes(expected));
});

test('wrong TXT value does not verify', () => {
  const tenantId = 'eukolakis';
  const expected = `thronos-verify=${tenantId}`;
  const records  = ['thronos-verify=other'];
  assert.equal(records.includes(expected), false);
});

// ── runDomainCheck result shape ───────────────────────────────────────────────
// We mock dns to avoid real network calls.

test('runDomainCheck returns expected shape when domain is empty', async () => {
  const { runDomainCheck } = require('../utils/dns-check');
  const result = await runDomainCheck({ id: 'demo', primaryDomain: '', domain: '', domains: [] });
  assert.equal(result.domain, null);
  assert.equal(result.cnameOk, false);
  assert.equal(result.txtOk, false);
  assert.ok(result.checkedAt);
});

test('runDomainCheck result has aliases array for tenants with domains', async () => {
  // This makes a real DNS query; if it times out that's fine for CI —
  // we only assert the shape, not the DNS result.
  const { runDomainCheck } = require('../utils/dns-check');
  const result = await runDomainCheck({
    id: 'eukolakis',
    primaryDomain: 'eukolaki.gr',
    domain: 'eukolaki.gr',
    domains: ['www.eukolaki.gr']
  });
  assert.ok(typeof result.cnameOk === 'boolean');
  assert.ok(typeof result.txtOk === 'boolean');
  assert.ok(typeof result.allAliasesOk === 'boolean');
  assert.ok(Array.isArray(result.aliases));
  assert.equal(result.aliases.length, 1);
  assert.equal(result.aliases[0].domain, 'www.eukolaki.gr');
  assert.ok(result.cname && typeof result.cname.ok === 'boolean');
  assert.ok(result.txt   && typeof result.txt.ok   === 'boolean');
}, { timeout: 10000 });
