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

// ── Custom domain tenants ─────────────────────────────────────────────────────

test('eukolaki.gr apex resolves to eukolakis', () => {
  const out = resolveTenantFromHost('eukolaki.gr', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

test('www.eukolaki.gr resolves to eukolakis', () => {
  const out = resolveTenantFromHost('www.eukolaki.gr', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

test('eukolaki.gr with port resolves to eukolakis', () => {
  const out = resolveTenantFromHost('eukolaki.gr:443', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

test('UPPER-CASE eukolaki.gr resolves to eukolakis', () => {
  const out = resolveTenantFromHost('EUKOLAKI.GR', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

// ── Preview / platform subdomain tenants ─────────────────────────────────────

test('eukolakis.thonoscommerce.thronoschain.org resolves to eukolakis', () => {
  const out = resolveTenantFromHost('eukolakis.thonoscommerce.thronoschain.org', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

test('eukolakis.thronoscommerce.thronoschain.org (typo variant) resolves to eukolakis', () => {
  const out = resolveTenantFromHost('eukolakis.thronoscommerce.thronoschain.org', tenants);
  assert.equal(out.type, 'tenant');
  assert.equal(out.tenant.id, 'eukolakis');
});

// ── Platform host ─────────────────────────────────────────────────────────────

test('localhost is classified as platform', () => {
  const out = resolveTenantFromHost('localhost:3000', tenants);
  assert.equal(out.type, 'platform');
});

test('thonoscommerce.thronoschain.org is platform', () => {
  const out = resolveTenantFromHost('thonoscommerce.thronoschain.org', tenants);
  assert.equal(out.type, 'platform');
});

test('railway internal host is platform', () => {
  const out = resolveTenantFromHost('thronos-commerce.railway.internal', tenants);
  assert.equal(out.type, 'platform');
});

test('up.railway.app host is platform', () => {
  const out = resolveTenantFromHost('thronos-commerce.up.railway.app', tenants);
  assert.equal(out.type, 'platform');
});

// ── Unknown host ──────────────────────────────────────────────────────────────

test('unknown host returns type unknown', () => {
  const out = resolveTenantFromHost('totally-unknown.example.com', tenants);
  assert.equal(out.type, 'unknown');
});

test('empty host returns unknown', () => {
  const out = resolveTenantFromHost('', tenants);
  assert.equal(out.type, 'unknown');
});

// ── Path-based preview must NOT be broken ─────────────────────────────────────
// (These tests confirm the resolver itself: path routing is in server.js middleware)

test('platform host does not accidentally resolve to a custom-domain tenant', () => {
  const out = resolveTenantFromHost('thonoscommerce.thronoschain.org', tenants);
  assert.notEqual(out.type, 'tenant', 'platform host must not match a custom-domain tenant directly');
});

test('www prefix of unknown domain returns unknown', () => {
  const out = resolveTenantFromHost('www.unknown-domain.gr', tenants);
  assert.equal(out.type, 'unknown');
});
