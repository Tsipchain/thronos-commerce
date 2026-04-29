const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const adminTpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin.ejs'), 'utf8');
const indexTpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'index.ejs'), 'utf8');

test('assistant panel route is registered', () => {
  assert.match(serverSource, /setupAdminAssistantRoutes\(/);
  assert.doesNotMatch(serverSource, /app.get\('\/admin\/assistant-panel'/);
  assert.doesNotMatch(serverSource, /normalizeLang\(/);
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
});
