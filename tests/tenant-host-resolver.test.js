const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTenantFromHost } = require('../utils/tenant-host-resolver');

const tenants = [
  {
    id: 'demo',
    domain: 'demo.thronoscommerce.local',
    primaryDomain: 'demo-shop.gr',
    domains: ['demo-shop.gr', 'www.demo-shop.gr'],
    previewSubdomain: 'demo'
  },
  {
    id: 'eukolakis',
    domain: 'eukolaki.gr',
    primaryDomain: 'eukolaki.gr',
    domains: ['eukolaki.gr', 'www.eukolaki.gr'],
    previewSubdomain: 'eukolakis'
  }
];

test('resolves configured custom apex host', () => {
  const out = resolveTenantFromHost('eukolaki.gr', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

test('resolves configured custom www host', () => {
  const out = resolveTenantFromHost('www.eukolaki.gr', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

test('resolves preview host', () => {
  const out = resolveTenantFromHost('eukolakis.thronoscommerce.thronoschain.org', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

test('classifies platform host', () => {
  const out = resolveTenantFromHost('localhost:3000', tenants);
  assert.equal(out.type, 'platform');
});

test('returns unknown for unresolved host', () => {
  const out = resolveTenantFromHost('unknown-host.example', tenants);
  assert.equal(out.type, 'unknown');
});
