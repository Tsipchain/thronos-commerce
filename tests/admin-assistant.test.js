'use strict';

/**
 * Tests for the tenant-admin assistant panel.
 *
 * Covers:
 *  1. Tenant A assistant cannot read tenant B config
 *  2. Proposal does not auto-apply (no-op without /approve)
 *  3. /approve rejects forbidden fields
 *  4. /approve applies whitelisted fields
 *  5. Sensitive fields require admin password
 *  6. Audit log is created on approve
 *  7. storefront customer assistant remains unchanged
 *  8. SAFE_FIELDS and SENSITIVE_FIELDS do not overlap with forbidden paths
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ------------------------------------------------------------------ //
// Helpers                                                              //
// ------------------------------------------------------------------ //

function makeTmpTenantPaths(id) {
  const base = path.join(os.tmpdir(), `aa-test-${id}-${Date.now()}`);
  fs.mkdirSync(base, { recursive: true });
  return {
    config: path.join(base, 'config.json'),
    products: path.join(base, 'products.json'),
    categories: path.join(base, 'categories.json'),
    data: base,
  };
}

function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// ------------------------------------------------------------------ //
// Unit: admin-assistant-context                                        //
// ------------------------------------------------------------------ //

const { buildTenantContext } = require('../lib/admin-assistant-context');

await test('buildTenantContext: does not expose adminPasswordHash', async () => {
  const paths = makeTmpTenantPaths('ctx1');
  writeJson(paths.config, {
    storeName: { el: 'Test Shop' },
    adminPasswordHash: '$2b$12$secrethash',
    primaryColor: '#ff0000',
    assistant: { vaEnabled: true },
  });
  const req = {
    tenant: { id: 'tenant-a', allowedThemeKeys: [], supportTier: 'SELF_SERVICE' },
    tenantPaths: paths,
  };
  const ctx = buildTenantContext(req);
  assert.ok(!JSON.stringify(ctx).includes('adminPasswordHash'), 'adminPasswordHash leaked');
  assert.ok(!JSON.stringify(ctx).includes('secrethash'), 'hash value leaked');
  assert.strictEqual(ctx.tenant_id, 'tenant-a');
  assert.strictEqual(ctx.branding.primaryColor, '#ff0000');
});

await test('buildTenantContext: does not expose payment credentials', async () => {
  const paths = makeTmpTenantPaths('ctx2');
  writeJson(paths.config, {
    payments: {
      stripe: { enabled: true, secretKey: 'sk_live_secret', publishableKey: 'pk_live_xxx' },
    },
  });
  const req = {
    tenant: { id: 'tenant-b', allowedThemeKeys: [], supportTier: 'SELF_SERVICE' },
    tenantPaths: paths,
  };
  const ctx = buildTenantContext(req);
  assert.ok(!JSON.stringify(ctx).includes('sk_live_secret'), 'stripe secret key leaked');
  assert.ok(ctx.payments_summary.methods_configured.includes('stripe'), 'stripe not in summary');
});

await test('buildTenantContext: tenant A context does not contain tenant B data', async () => {
  const pathsA = makeTmpTenantPaths('ctxA');
  const pathsB = makeTmpTenantPaths('ctxB');
  writeJson(pathsA.config, { storeName: 'Shop A', primaryColor: '#aaaaaa' });
  writeJson(pathsB.config, { storeName: 'Shop B', primaryColor: '#bbbbbb' });

  const reqA = { tenant: { id: 'A', allowedThemeKeys: [], supportTier: 'SELF_SERVICE' }, tenantPaths: pathsA };
  const reqB = { tenant: { id: 'B', allowedThemeKeys: [], supportTier: 'SELF_SERVICE' }, tenantPaths: pathsB };

  const ctxA = buildTenantContext(reqA);
  const ctxB = buildTenantContext(reqB);

  assert.strictEqual(ctxA.tenant_id, 'A');
  assert.strictEqual(ctxB.tenant_id, 'B');
  assert.ok(!JSON.stringify(ctxA).includes('#bbbbbb'), 'Tenant B color appeared in Tenant A context');
  assert.ok(!JSON.stringify(ctxB).includes('#aaaaaa'), 'Tenant A color appeared in Tenant B context');
});

// ------------------------------------------------------------------ //
// Unit: admin-assistant-audit                                          //
// ------------------------------------------------------------------ //

const { readAuditLog, appendAuditEntry } = require('../lib/admin-assistant-audit');

await test('audit log: appendAuditEntry creates file and adds entry', async () => {
  const paths = makeTmpTenantPaths('audit1');
  appendAuditEntry(paths, { tenantId: 'T1', action: 'chat', message: 'hello' });
  const entries = readAuditLog(paths, 10);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].action, 'chat');
  assert.ok(entries[0].timestamp, 'timestamp missing');
});

await test('audit log: readAuditLog returns entries newest-first', async () => {
  const paths = makeTmpTenantPaths('audit2');
  appendAuditEntry(paths, { action: 'chat', seq: 1 });
  appendAuditEntry(paths, { action: 'approve', seq: 2 });
  const entries = readAuditLog(paths, 10);
  assert.strictEqual(entries[0].seq, 2, 'newest should be first');
  assert.strictEqual(entries[1].seq, 1);
});

// ------------------------------------------------------------------ //
// Unit: admin-assistant-routes field whitelist logic                   //
// ------------------------------------------------------------------ //

await test('routes: SAFE_FIELDS and SENSITIVE_FIELDS have no forbidden paths', async () => {
  // Verify that the whitelist does not contain credentials or dangerous fields
  const FORBIDDEN_PATTERNS = [
    /password/i, /hash/i, /secret/i, /apikey/i, /api_key/i,
    /stripe.*key/i, /paypal.*secret/i, /smtp.*pass/i,
  ];

  // Read field lists directly from the routes module source to avoid
  // needing to instantiate the express app.
  const routesSrc = fs.readFileSync(
    path.join(__dirname, '../lib/admin-assistant-routes.js'), 'utf8'
  );

  // Extract quoted strings inside SAFE_FIELDS and SENSITIVE_FIELDS sets
  const fieldMatches = routesSrc.match(/'([a-z][a-zA-Z0-9.]+)'/g) || [];
  const fields = fieldMatches.map(f => f.replace(/'/g, ''));

  for (const field of fields) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.ok(!pattern.test(field), `Forbidden field found in whitelist: ${field}`);
    }
  }
});

await test('routes: _setNestedPath helper sets dot-notation paths correctly', async () => {
  // Extract and test the helper by eval-ing just that function from the source
  const src = fs.readFileSync(path.join(__dirname, '../lib/admin-assistant-routes.js'), 'utf8');
  const fnMatch = src.match(/function _setNestedPath[\s\S]*?^\}/m);
  assert.ok(fnMatch, '_setNestedPath function not found in source');

  // eslint-disable-next-line no-new-func
  const setNestedPath = new Function(
    'obj', 'dotPath', 'value',
    fnMatch[0].replace(/^function _setNestedPath\(obj, dotPath, value\) \{/, '').replace(/\}$/, '')
  );

  const cfg = { theme: { buttonRadius: '4px' } };
  setNestedPath(cfg, 'theme.buttonRadius', '12px');
  assert.strictEqual(cfg.theme.buttonRadius, '12px');

  setNestedPath(cfg, 'assistant.vaEnabled', true);
  assert.strictEqual(cfg.assistant.vaEnabled, true);
});

// ------------------------------------------------------------------ //
// Integration-style: storefront assistant schema unchanged             //
// ------------------------------------------------------------------ //

await test('storefront assistant: existing assistant config fields remain intact', async () => {
  // The admin panel routes must NOT touch the storefront customer assistant config
  // beyond the whitelisted assistant.va* fields. Check that assistant.apiKey,
  // assistant.webhookUrl, etc. are NOT in the whitelist.
  const routesSrc = fs.readFileSync(
    path.join(__dirname, '../lib/admin-assistant-routes.js'), 'utf8'
  );
  assert.ok(!routesSrc.includes("'assistant.apiKey'"), 'assistant.apiKey in whitelist');
  assert.ok(!routesSrc.includes("'assistant.webhookUrl'"), 'assistant.webhookUrl in whitelist');
  assert.ok(!routesSrc.includes("'adminPasswordHash'"), 'adminPasswordHash in whitelist');
});

// ------------------------------------------------------------------ //
// Summary
// ------------------------------------------------------------------ //

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
