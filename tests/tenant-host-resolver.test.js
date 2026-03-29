const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTenantFromHost } = require('../utils/tenant-host-resolver');

const tenants = [
  {
    id: 'eukolakis',
    primaryDomain: 'eukolaki.gr',
    domains: ['eukolaki.gr', 'www.eukolaki.gr'],
    previewSubdomain: 'eukolakis',
    domainStatus: 'active'
  }
];

test('preview domain resolves to tenant', () => {
  const result = resolveTenantFromHost('eukolakis.thronoscommerce.thronoschain.org', tenants);
  assert.equal(result.type, 'tenant');
  assert.equal(result.tenant.id, 'eukolakis');
});

test('custom domain resolves to tenant', () => {
  const result = resolveTenantFromHost('www.eukolaki.gr', tenants);
  assert.equal(result.type, 'tenant');
  assert.equal(result.tenant.id, 'eukolakis');
});

test('unknown custom domain resolves unknown', () => {
  const result = resolveTenantFromHost('unknown-shop.gr', tenants);
  assert.equal(result.type, 'unknown');
});

test('platform host resolves platform', () => {
  const result = resolveTenantFromHost('thronoscommerce.thronoschain.org', tenants);
  assert.equal(result.type, 'platform');
});

test('apex host resolves tenant when only www is configured', () => {
  const onlyWwwTenant = [{ id: 'shop', domains: ['www.shop.gr'] }];
  const result = resolveTenantFromHost('shop.gr', onlyWwwTenant);
  assert.equal(result.type, 'tenant');
  assert.equal(result.tenant.id, 'shop');
});

test('preview host is not mistaken for platform host', () => {
  const result = resolveTenantFromHost('eukolakis.thonoscommerce.thronoschain.org', tenants);
  assert.equal(result.type, 'tenant');
  assert.equal(result.tenant.id, 'eukolakis');
});
