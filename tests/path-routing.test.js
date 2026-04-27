const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTenantFromHost } = require('../utils/tenant-host-resolver');

// ── Path-based routing: /t/:tenantId ─────────────────────────────────────────
// The actual URL rewriting happens in server.js middleware, but the path
// parsing logic below mirrors what server.js does so we can unit-test it
// without spinning up the server.

function parseTenantPath(url) {
  const m = /^\/t\/([a-z0-9_-]+)(\/.*)?$/i.exec(String(url || ''));
  if (!m) return null;
  return { tenantId: m[1], restPath: m[2] || '/' };
}

test('/t/eukolakis extracts tenantId', () => {
  const r = parseTenantPath('/t/eukolakis');
  assert.ok(r, 'should match');
  assert.equal(r.tenantId, 'eukolakis');
  assert.equal(r.restPath, '/');
});

test('/t/eukolakis/ with trailing slash', () => {
  const r = parseTenantPath('/t/eukolakis/');
  assert.ok(r);
  assert.equal(r.tenantId, 'eukolakis');
  assert.equal(r.restPath, '/');
});

test('/t/eukolakis/product/123 extracts tenantId and restPath', () => {
  const r = parseTenantPath('/t/eukolakis/product/123');
  assert.ok(r);
  assert.equal(r.tenantId, 'eukolakis');
  assert.equal(r.restPath, '/product/123');
});

test('/t/demo works for demo tenant', () => {
  const r = parseTenantPath('/t/demo');
  assert.ok(r);
  assert.equal(r.tenantId, 'demo');
});

test('/ is not a path tenant route', () => {
  assert.equal(parseTenantPath('/'), null);
});

test('/admin is not a path tenant route', () => {
  assert.equal(parseTenantPath('/admin'), null);
});

test('/t/ with no tenantId is not matched', () => {
  assert.equal(parseTenantPath('/t/'), null);
});

// ── Custom domain Host header routing ─────────────────────────────────────────
// These tests use the same tenant fixtures as tenant-host-resolver.test.js
// but focus on the specific eukolakis domain requirements from the issue.

const tenants = [
  {
    id: 'eukolakis',
    domain: 'eukolaki.gr',
    primaryDomain: 'eukolaki.gr',
    domains: ['www.eukolaki.gr'],
    previewSubdomain: 'eukolakis'
  },
  {
    id: 'demo',
    domain: 'demo.thronoscommerce.local',
    previewSubdomain: 'demo'
  }
];

test('eukolaki.gr Host header resolves to eukolakis tenant', () => {
  const out = resolveTenantFromHost('eukolaki.gr', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

test('www.eukolaki.gr Host header resolves to eukolakis tenant', () => {
  const out = resolveTenantFromHost('www.eukolaki.gr', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

test('eukolaki.gr:443 (with port) resolves to eukolakis tenant', () => {
  const out = resolveTenantFromHost('eukolaki.gr:443', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

test('platform host does not hijack a custom-domain tenant request', () => {
  const out = resolveTenantFromHost('thonoscommerce.thronoschain.org', tenants);
  assert.equal(out.type, 'platform', 'platform host should not resolve as tenant');
});

test('/t/eukolakis path route parser returns the right tenantId', () => {
  const r = parseTenantPath('/t/eukolakis');
  assert.equal(r.tenantId, 'eukolakis');
});

test('/t/eukolakis path route does not collide with custom domain routing', () => {
  // Path routing and host routing are independent layers.
  // This confirms the parser extracts eukolakis regardless of Host.
  const r = parseTenantPath('/t/eukolakis/products');
  assert.equal(r.tenantId, 'eukolakis');
  assert.equal(r.restPath, '/products');
});
