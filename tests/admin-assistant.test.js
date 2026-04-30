const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const adminTpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin.ejs'), 'utf8');
const indexTpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'index.ejs'), 'utf8');
const adminAssistantTpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin-assistant-panel.ejs'), 'utf8');

test('assistant panel route is registered', () => {
  assert.match(serverSource, /setupAdminAssistantRoutes\(/);
  assert.doesNotMatch(serverSource, /app.get\('\/admin\/assistant-panel'/);
  assert.doesNotMatch(serverSource, /normalizeLang\(/);
  assert.doesNotMatch(serverSource, /setupAdminAssistantRoutes\([\s\S]*withTenantLink[\s\S]*\)/);
});

test('assistant panel link is visible in admin sidebar', () => {
  assert.match(adminTpl, /\/admin\/assistant-panel/);
});

test('eukolakis theme toggle mounts in header slot', () => {
  assert.match(indexTpl, /header-mode-toggle-slot/);
  assert.match(indexTpl, /querySelector\('\.header-mode-toggle-slot'\)/);
});

test('admin assistant chat route targets admin assistant endpoint', () => {
  const mod = fs.readFileSync(path.join(__dirname, '..', 'lib', 'admin-assistant-routes.js'), 'utf8');
  assert.match(mod, /\/api\/v1\/admin\/assistant\/chat/);
  assert.match(mod, /res\.render\('admin-assistant-panel'/);
});

test('assistant panel template includes visible marker', () => {
  assert.match(adminAssistantTpl, /Tenant Admin Assistant Panel/);
  assert.doesNotMatch(adminAssistantTpl, /Dashboard/);
});

test('/api/chat uses customer endpoint with safer timeout and structured logging', () => {
  assert.match(serverSource, /\/api\/v1\/assistant\/chat/);
  assert.match(serverSource, /timeout:\s*20000/);
  assert.match(serverSource, /\[VA chat\] proxy error/);
  assert.match(serverSource, /targetHost/);
  assert.match(serverSource, /X-Thronos-Shared-Secret/);
});
