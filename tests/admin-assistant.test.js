'use strict';

/**
 * Tests for the tenant-admin assistant panel.
 *
 * Groups:
 *  A. buildTenantContext — credential isolation, tenant separation
 *  B. audit log — append/read behaviour
 *  C. routes whitelist — field safety, _setNestedPath logic
 *  D. env resolution — fallback order, trailing-slash strip, no-secret log
 *  E. chat proxy — missing URL → 503; VCA 502 forwarded; wrong secret → 401
 *  F. storefront assistant unchanged
 */

const assert = require('assert');
const fs     = require('fs');
const http   = require('http');
const os     = require('os');
const path   = require('path');

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
// Shared helpers                                                        //
// ------------------------------------------------------------------ //

function makeTmpTenantPaths(id) {
  const base = path.join(os.tmpdir(), `aa-test-${id}-${Date.now()}`);
  fs.mkdirSync(base, { recursive: true });
  return {
    config    : path.join(base, 'config.json'),
    products  : path.join(base, 'products.json'),
    categories: path.join(base, 'categories.json'),
    data      : base,
  };
}

function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); }

// Spin up a throw-away HTTP server that responds with a fixed status + JSON body.
function startMockVCA(statusCode, responseBody) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// Build a minimal mock Express app that captures route registrations.
function buildMockApp() {
  const routes = { get: [], post: [] };
  const app = {
    _routes: routes,
    get(p, ...handlers)  { routes.get.push({ path: p, handlers }); },
    post(p, ...handlers) { routes.post.push({ path: p, handlers }); },
    findLast(method, p) {
      const r = routes[method].find(rt => rt.path === p);
      return r ? r.handlers[r.handlers.length - 1] : null;
    },
  };
  return app;
}

// Minimal mock req/res for direct handler invocation.
function buildMockReq(overrides) {
  return {
    body       : {},
    query      : {},
    tenant     : { id: 'test-tenant' },
    tenantPaths: makeTmpTenantPaths('req'),
    session    : { admin: { tenantId: 'test-tenant' } },
    ...overrides,
  };
}

function buildMockRes() {
  const res = {
    _status: 200, _json: null,
    status(c) { res._status = c; return res; },
    json(b)   { res._json  = b; return res; },
    render(v, d) { res._rendered = { v, d }; return res; },
  };
  return res;
}

// Stub deps for setupAdminAssistantRoutes.
const STUB_DEPS = {
  requireAdmin     : (req, res, next) => next(),
  loadTenantConfig : () => ({}),
  saveTenantConfig : () => {},
  verifyAdminAction: async () => ({ ok: true }),
  buildAdminViewModel: (req, opts) => opts,
};

// Clear module cache so re-require picks up env changes made in tests.
function clearModuleCache() {
  for (const key of [
    '../lib/admin-assistant-env',
    '../lib/admin-assistant-routes',
  ]) {
    const resolved = require.resolve(key);
    delete require.cache[resolved];
  }
}

// ================================================================== //
// A. buildTenantContext                                                //
// ================================================================== //

const { buildTenantContext } = require('../lib/admin-assistant-context');

await test('A1: buildTenantContext does not expose adminPasswordHash', async () => {
  const paths = makeTmpTenantPaths('ctx1');
  writeJson(paths.config, {
    storeName: { el: 'Test Shop' },
    adminPasswordHash: '$2b$12$secrethash',
    primaryColor: '#ff0000',
    assistant: { vaEnabled: true },
  });
  const req = { tenant: { id: 'T-a', allowedThemeKeys: [], supportTier: 'SELF_SERVICE' }, tenantPaths: paths };
  const ctx = buildTenantContext(req);
  assert.ok(!JSON.stringify(ctx).includes('adminPasswordHash'), 'adminPasswordHash leaked');
  assert.ok(!JSON.stringify(ctx).includes('secrethash'),       'hash value leaked');
  assert.strictEqual(ctx.branding.primaryColor, '#ff0000');
});

await test('A2: buildTenantContext does not expose payment credentials', async () => {
  const paths = makeTmpTenantPaths('ctx2');
  writeJson(paths.config, {
    payments: { stripe: { enabled: true, secretKey: 'sk_live_secret', publishableKey: 'pk_live_xxx' } },
  });
  const req = { tenant: { id: 'T-b', allowedThemeKeys: [], supportTier: 'SELF_SERVICE' }, tenantPaths: paths };
  const ctx = buildTenantContext(req);
  assert.ok(!JSON.stringify(ctx).includes('sk_live_secret'),          'stripe secret key leaked');
  assert.ok(ctx.payments_summary.methods_configured.includes('stripe'), 'stripe not in summary');
});

await test('A3: tenant A context never contains tenant B data', async () => {
  const pathsA = makeTmpTenantPaths('ctxA');
  const pathsB = makeTmpTenantPaths('ctxB');
  writeJson(pathsA.config, { primaryColor: '#aaaaaa' });
  writeJson(pathsB.config, { primaryColor: '#bbbbbb' });
  const ctxA = buildTenantContext({ tenant: { id: 'A', allowedThemeKeys: [], supportTier: 'SELF_SERVICE' }, tenantPaths: pathsA });
  const ctxB = buildTenantContext({ tenant: { id: 'B', allowedThemeKeys: [], supportTier: 'SELF_SERVICE' }, tenantPaths: pathsB });
  assert.ok(!JSON.stringify(ctxA).includes('#bbbbbb'), 'B color in A context');
  assert.ok(!JSON.stringify(ctxB).includes('#aaaaaa'), 'A color in B context');
});

// ================================================================== //
// B. Audit log                                                         //
// ================================================================== //

const { readAuditLog, appendAuditEntry } = require('../lib/admin-assistant-audit');

await test('B1: appendAuditEntry creates file and adds timestamped entry', async () => {
  const paths = makeTmpTenantPaths('audit1');
  appendAuditEntry(paths, { tenantId: 'T1', action: 'chat', message: 'hello' });
  const entries = readAuditLog(paths, 10);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].action, 'chat');
  assert.ok(entries[0].timestamp, 'timestamp missing');
});

await test('B2: readAuditLog returns entries newest-first', async () => {
  const paths = makeTmpTenantPaths('audit2');
  appendAuditEntry(paths, { action: 'chat',    seq: 1 });
  appendAuditEntry(paths, { action: 'approve', seq: 2 });
  const entries = readAuditLog(paths, 10);
  assert.strictEqual(entries[0].seq, 2, 'newest should be first');
  assert.strictEqual(entries[1].seq, 1);
});

// ================================================================== //
// C. Routes whitelist                                                  //
// ================================================================== //

await test('C1: whitelist contains no credential-like field paths', async () => {
  const FORBIDDEN_PATTERNS = [
    /password/i, /hash/i, /secret/i, /apikey/i, /api_key/i,
    /stripe.*key/i, /paypal.*secret/i, /smtp.*pass/i,
  ];
  const src = fs.readFileSync(path.join(__dirname, '../lib/admin-assistant-routes.js'), 'utf8');
  const fields = (src.match(/'([a-z][a-zA-Z0-9.]+)'/g) || []).map(f => f.replace(/'/g, ''));
  for (const field of fields) {
    for (const pat of FORBIDDEN_PATTERNS) {
      assert.ok(!pat.test(field), `Forbidden field in whitelist: ${field}`);
    }
  }
});

await test('C2: _setNestedPath sets dot-notation paths correctly', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/admin-assistant-routes.js'), 'utf8');
  const fnMatch = src.match(/function _setNestedPath[\s\S]*?^\}/m);
  assert.ok(fnMatch, '_setNestedPath not found');
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'obj', 'dotPath', 'value',
    fnMatch[0].replace(/^function _setNestedPath\(obj, dotPath, value\) \{/, '').replace(/\}$/, '')
  );
  const cfg = { theme: { buttonRadius: '4px' } };
  fn(cfg, 'theme.buttonRadius', '12px');
  assert.strictEqual(cfg.theme.buttonRadius, '12px');
  fn(cfg, 'assistant.vaEnabled', true);
  assert.strictEqual(cfg.assistant.vaEnabled, true);
});

// ================================================================== //
// D. Env resolution                                                    //
// ================================================================== //

await test('D1: resolveVcaUrl — THRONOS_ASSISTANT_URL wins over all others', async () => {
  const saved = {};
  for (const k of ['THRONOS_ASSISTANT_URL', 'ASSISTANT_API_URL', 'VCA_URL'])
    { saved[k] = process.env[k]; process.env[k] = ''; }
  process.env.THRONOS_ASSISTANT_URL = 'https://primary.example.com';
  process.env.ASSISTANT_API_URL     = 'https://secondary.example.com';
  process.env.VCA_URL               = 'https://tertiary.example.com';

  const { resolveVcaUrl } = require('../lib/admin-assistant-env');
  const r = resolveVcaUrl();
  assert.strictEqual(r.source, 'THRONOS_ASSISTANT_URL');
  assert.strictEqual(r.url,    'https://primary.example.com');

  for (const [k, v] of Object.entries(saved))
    { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
});

await test('D2: resolveVcaUrl — ASSISTANT_API_URL used when THRONOS_ASSISTANT_URL absent', async () => {
  const saved = {};
  for (const k of ['THRONOS_ASSISTANT_URL', 'ASSISTANT_API_URL', 'VCA_URL'])
    { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.ASSISTANT_API_URL = 'https://secondary.example.com';
  process.env.VCA_URL           = 'https://tertiary.example.com';

  const { resolveVcaUrl } = require('../lib/admin-assistant-env');
  const r = resolveVcaUrl();
  assert.strictEqual(r.source, 'ASSISTANT_API_URL');
  assert.strictEqual(r.url,    'https://secondary.example.com');

  for (const [k, v] of Object.entries(saved))
    { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
});

await test('D3: resolveVcaUrl — VCA_URL used as last fallback', async () => {
  const saved = {};
  for (const k of ['THRONOS_ASSISTANT_URL', 'ASSISTANT_API_URL', 'VCA_URL'])
    { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.VCA_URL = 'https://tertiary.example.com';

  const { resolveVcaUrl } = require('../lib/admin-assistant-env');
  const r = resolveVcaUrl();
  assert.strictEqual(r.source, 'VCA_URL');

  for (const [k, v] of Object.entries(saved))
    { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
});

await test('D4: resolveVcaUrl — source=none when all absent', async () => {
  const saved = {};
  for (const k of ['THRONOS_ASSISTANT_URL', 'ASSISTANT_API_URL', 'VCA_URL'])
    { saved[k] = process.env[k]; delete process.env[k]; }

  const { resolveVcaUrl } = require('../lib/admin-assistant-env');
  const r = resolveVcaUrl();
  assert.strictEqual(r.source, 'none');
  assert.strictEqual(r.url,    '');

  for (const [k, v] of Object.entries(saved))
    { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
});

await test('D5: resolveVcaUrl strips trailing slash', async () => {
  const saved = process.env.THRONOS_ASSISTANT_URL;
  process.env.THRONOS_ASSISTANT_URL = 'https://example.com/vca/';
  const { resolveVcaUrl } = require('../lib/admin-assistant-env');
  assert.strictEqual(resolveVcaUrl().url, 'https://example.com/vca');
  if (saved !== undefined) process.env.THRONOS_ASSISTANT_URL = saved;
  else delete process.env.THRONOS_ASSISTANT_URL;
});

await test('D6: resolveWebhookSecret — COMMERCE_WEBHOOK_SECRET wins', async () => {
  const saved = {};
  for (const k of ['COMMERCE_WEBHOOK_SECRET', 'ASSISTANT_WEBHOOK_SECRET'])
    { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.COMMERCE_WEBHOOK_SECRET   = 'primary-secret';
  process.env.ASSISTANT_WEBHOOK_SECRET  = 'fallback-secret';

  const { resolveWebhookSecret } = require('../lib/admin-assistant-env');
  const r = resolveWebhookSecret();
  assert.strictEqual(r.source, 'COMMERCE_WEBHOOK_SECRET');
  assert.strictEqual(r.secret, 'primary-secret');

  for (const [k, v] of Object.entries(saved))
    { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
});

await test('D7: resolveWebhookSecret — ASSISTANT_WEBHOOK_SECRET used as fallback', async () => {
  const saved = {};
  for (const k of ['COMMERCE_WEBHOOK_SECRET', 'ASSISTANT_WEBHOOK_SECRET'])
    { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.ASSISTANT_WEBHOOK_SECRET = 'fallback-secret';

  const { resolveWebhookSecret } = require('../lib/admin-assistant-env');
  const r = resolveWebhookSecret();
  assert.strictEqual(r.source, 'ASSISTANT_WEBHOOK_SECRET');
  assert.strictEqual(r.secret, 'fallback-secret');

  for (const [k, v] of Object.entries(saved))
    { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
});

await test('D8: logAssistantBoot never prints secret values', async () => {
  const savedUrl    = process.env.THRONOS_ASSISTANT_URL;
  const savedSecret = process.env.COMMERCE_WEBHOOK_SECRET;
  process.env.THRONOS_ASSISTANT_URL    = 'https://vca.example.com';
  process.env.COMMERCE_WEBHOOK_SECRET  = 'super-secret-value-99999';

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  const { logAssistantBoot } = require('../lib/admin-assistant-env');
  logAssistantBoot('test');

  console.log = origLog;

  const output = logs.join('\n');
  assert.ok(!output.includes('super-secret-value-99999'), 'Secret value printed in boot log');
  assert.ok(output.includes('COMMERCE_WEBHOOK_SECRET'),  'Secret source name missing from boot log');
  assert.ok(output.includes('THRONOS_ASSISTANT_URL'),    'URL source name missing from boot log');

  if (savedUrl    !== undefined) process.env.THRONOS_ASSISTANT_URL   = savedUrl;    else delete process.env.THRONOS_ASSISTANT_URL;
  if (savedSecret !== undefined) process.env.COMMERCE_WEBHOOK_SECRET = savedSecret; else delete process.env.COMMERCE_WEBHOOK_SECRET;
});

// ================================================================== //
// E. Chat proxy (using mock req/res + mock HTTP server)               //
// ================================================================== //

await test('E1: /admin/assistant-panel/chat — missing URL returns 503', async () => {
  const saved = {};
  for (const k of ['THRONOS_ASSISTANT_URL', 'ASSISTANT_API_URL', 'VCA_URL'])
    { saved[k] = process.env[k]; delete process.env[k]; }
  clearModuleCache();

  const app = buildMockApp();
  require('../lib/admin-assistant-routes')(app, STUB_DEPS);

  const handler = app.findLast('post', '/admin/assistant-panel/chat');
  assert.ok(handler, 'chat route not registered');

  const req = buildMockReq({ body: { message: 'hello' } });
  const res = buildMockRes();
  await handler(req, res);

  assert.strictEqual(res._status, 503);
  assert.ok(res._json && res._json.error, 'expected error body');

  for (const [k, v] of Object.entries(saved))
    { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
  clearModuleCache();
});

await test('E2: /admin/assistant-panel/chat — VCA 502 forwarded as 502', async () => {
  let mockServer;
  const savedUrl    = process.env.THRONOS_ASSISTANT_URL;
  const savedSecret = process.env.COMMERCE_WEBHOOK_SECRET;
  const savedTimeout = process.env.VCA_PROXY_TIMEOUT_MS;
  try {
    mockServer = await startMockVCA(502, { detail: 'VCA internal error' });
    const port = mockServer.address().port;

    process.env.THRONOS_ASSISTANT_URL   = `http://127.0.0.1:${port}`;
    process.env.COMMERCE_WEBHOOK_SECRET = 'test-secret';
    process.env.VCA_PROXY_TIMEOUT_MS    = '5000';
    clearModuleCache();

    const app = buildMockApp();
    require('../lib/admin-assistant-routes')(app, STUB_DEPS);
    const handler = app.findLast('post', '/admin/assistant-panel/chat');

    const req = buildMockReq({ body: { message: 'hi' } });
    const res = buildMockRes();
    await handler(req, res);

    assert.strictEqual(res._status, 502, `expected 502, got ${res._status}`);
    assert.ok(res._json && res._json.error, 'expected error body');
  } finally {
    if (mockServer) mockServer.close();
    if (savedUrl    !== undefined) process.env.THRONOS_ASSISTANT_URL   = savedUrl;    else delete process.env.THRONOS_ASSISTANT_URL;
    if (savedSecret !== undefined) process.env.COMMERCE_WEBHOOK_SECRET = savedSecret; else delete process.env.COMMERCE_WEBHOOK_SECRET;
    if (savedTimeout !== undefined) process.env.VCA_PROXY_TIMEOUT_MS   = savedTimeout; else delete process.env.VCA_PROXY_TIMEOUT_MS;
    clearModuleCache();
  }
});

await test('E3: /admin/assistant-panel/chat — VCA 401 (wrong secret) forwarded as 502', async () => {
  let mockServer;
  const savedUrl    = process.env.THRONOS_ASSISTANT_URL;
  const savedSecret = process.env.COMMERCE_WEBHOOK_SECRET;
  try {
    mockServer = await startMockVCA(401, { detail: 'Invalid or missing X-Thronos-Commerce-Key' });
    const port = mockServer.address().port;

    process.env.THRONOS_ASSISTANT_URL   = `http://127.0.0.1:${port}`;
    process.env.COMMERCE_WEBHOOK_SECRET = 'wrong-secret';
    process.env.VCA_PROXY_TIMEOUT_MS    = '5000';
    clearModuleCache();

    const app = buildMockApp();
    require('../lib/admin-assistant-routes')(app, STUB_DEPS);
    const handler = app.findLast('post', '/admin/assistant-panel/chat');

    const req = buildMockReq({ body: { message: 'hi' } });
    const res = buildMockRes();
    await handler(req, res);

    // 401 < 500 but we map non-200 upstream responses to 502 for the admin panel
    assert.strictEqual(res._status, 502, `expected 502 for upstream 401, got ${res._status}`);
    assert.ok(res._json && res._json.error, 'expected error body');
  } finally {
    if (mockServer) mockServer.close();
    if (savedUrl    !== undefined) process.env.THRONOS_ASSISTANT_URL   = savedUrl;    else delete process.env.THRONOS_ASSISTANT_URL;
    if (savedSecret !== undefined) process.env.COMMERCE_WEBHOOK_SECRET = savedSecret; else delete process.env.COMMERCE_WEBHOOK_SECRET;
    delete process.env.VCA_PROXY_TIMEOUT_MS;
    clearModuleCache();
  }
});

await test('E4: /admin/assistant-panel/chat — VCA timeout returns 504', async () => {
  let mockServer;
  const savedUrl    = process.env.THRONOS_ASSISTANT_URL;
  const savedTimeout = process.env.VCA_PROXY_TIMEOUT_MS;
  try {
    // Mock VCA that never responds — triggers timeout
    mockServer = await new Promise((resolve, reject) => {
      const s = http.createServer((_req, _res) => { /* intentionally hang */ });
      s.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    const port = mockServer.address().port;

    process.env.THRONOS_ASSISTANT_URL = `http://127.0.0.1:${port}`;
    process.env.VCA_PROXY_TIMEOUT_MS  = '200';   // 200 ms so test is fast
    clearModuleCache();

    const app = buildMockApp();
    require('../lib/admin-assistant-routes')(app, STUB_DEPS);
    const handler = app.findLast('post', '/admin/assistant-panel/chat');

    const req = buildMockReq({ body: { message: 'hi' } });
    const res = buildMockRes();
    await handler(req, res);

    assert.strictEqual(res._status, 504, `expected 504 on timeout, got ${res._status}`);
    assert.ok(res._json && res._json.error, 'expected error body');
  } finally {
    if (mockServer) mockServer.close();
    if (savedUrl    !== undefined) process.env.THRONOS_ASSISTANT_URL  = savedUrl;    else delete process.env.THRONOS_ASSISTANT_URL;
    if (savedTimeout !== undefined) process.env.VCA_PROXY_TIMEOUT_MS  = savedTimeout; else delete process.env.VCA_PROXY_TIMEOUT_MS;
    clearModuleCache();
  }
});

await test('E5: /admin/assistant-panel/chat — VCA 200 success proxied correctly', async () => {
  let mockServer;
  const savedUrl    = process.env.THRONOS_ASSISTANT_URL;
  const savedSecret = process.env.COMMERCE_WEBHOOK_SECRET;
  try {
    const vcaPayload = { response: 'Hello!', proposed_patches: [], intent: 'admin_guidance' };
    mockServer = await startMockVCA(200, vcaPayload);
    const port = mockServer.address().port;

    process.env.THRONOS_ASSISTANT_URL   = `http://127.0.0.1:${port}`;
    process.env.COMMERCE_WEBHOOK_SECRET = 'valid-secret';
    clearModuleCache();

    const app = buildMockApp();
    require('../lib/admin-assistant-routes')(app, STUB_DEPS);
    const handler = app.findLast('post', '/admin/assistant-panel/chat');

    const req = buildMockReq({ body: { message: 'hello' } });
    const res = buildMockRes();
    await handler(req, res);

    assert.strictEqual(res._status, 200, `expected 200, got ${res._status}`);
    assert.strictEqual(res._json && res._json.response, 'Hello!');
  } finally {
    if (mockServer) mockServer.close();
    if (savedUrl    !== undefined) process.env.THRONOS_ASSISTANT_URL   = savedUrl;    else delete process.env.THRONOS_ASSISTANT_URL;
    if (savedSecret !== undefined) process.env.COMMERCE_WEBHOOK_SECRET = savedSecret; else delete process.env.COMMERCE_WEBHOOK_SECRET;
    clearModuleCache();
  }
});

// ================================================================== //
// F. Storefront assistant unchanged                                    //
// ================================================================== //

await test('F1: storefront assistant.apiKey and webhookUrl not in whitelist', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/admin-assistant-routes.js'), 'utf8');
  assert.ok(!src.includes("'assistant.apiKey'"),    'assistant.apiKey in whitelist');
  assert.ok(!src.includes("'assistant.webhookUrl'"), 'assistant.webhookUrl in whitelist');
  assert.ok(!src.includes("'adminPasswordHash'"),    'adminPasswordHash in whitelist');
});

await test('F2: routes module uses resolveVcaUrl not raw VCA_URL env', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/admin-assistant-routes.js'), 'utf8');
  assert.ok(src.includes('resolveVcaUrl'),      'resolveVcaUrl not used in routes');
  assert.ok(src.includes('resolveWebhookSecret'), 'resolveWebhookSecret not used in routes');
  // Must not hard-code the old env var names directly as a string literal lookup
  assert.ok(!src.includes("process.env.VCA_URL"), 'raw process.env.VCA_URL still in routes');
  assert.ok(!src.includes("process.env.COMMERCE_WEBHOOK_SECRET"), 'raw COMMERCE_WEBHOOK_SECRET still in routes');
});

// ================================================================== //
// Summary                                                              //
// ================================================================== //

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
