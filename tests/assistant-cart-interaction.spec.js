const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const bcrypt = require('bcryptjs');

const root = path.join(__dirname, '..');

let child, port, tempRoot;

test.beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-cart-'));
  fs.cpSync(path.join(root, 'data'), tempRoot, { recursive: true });
  const configPath = path.join(tempRoot, 'tenants/eukolakis/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.homepage.introEnabled = false;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const tenantsPath = path.join(tempRoot, 'tenants.json');
  const tenants = JSON.parse(fs.readFileSync(tenantsPath, 'utf8'));
  tenants.find(t => t.id === 'eukolakis').adminPasswordHash = bcrypt.hashSync('test', 4);
  fs.writeFileSync(tenantsPath, JSON.stringify(tenants, null, 2));

  port = 35000 + Math.floor(Math.random() * 1000);
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', THRC_DATA_ROOT: tempRoot,
      SESSION_SECRET: 'pw-test-secret', THRONOS_ROOT_ADMIN_PASSWORD: 'pw-root' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes(`listening on port ${port}`)) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => reject(new Error(`server exited: ${code}`)));
  });
});

test.afterAll(async () => {
  if (child) child.kill('SIGTERM');
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('desktop: assistant left-anchored, cart wins layering', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://eukolaki.gr:${port}/?skipIntro=1`);
  await page.waitForLoadState('networkidle');

  const fab = page.locator('#thrc-chat-fab');
  await expect(fab).toBeVisible({ timeout: 5000 });
  const fabBox = await fab.boundingBox();
  expect(fabBox.x).toBeLessThan(100);
  expect(fabBox.y).toBeGreaterThan(700);

  await fab.click();
  const panel = page.locator('#thrc-chat-panel');
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox.x).toBeLessThan(100);

  const cart = page.locator('#floating-cart');
  await expect(cart).toBeVisible();
  const cartBox = await cart.boundingBox();
  expect(cartBox.x).toBeGreaterThan(1300);

  await cart.click({ force: true });
  const cartPanel = page.locator('#cart-panel');
  await expect(cartPanel).toBeVisible({ timeout: 3000 });
  await expect(panel).toBeHidden();

  await page.click('body', { position: { x: 600, y: 400 } });
  await expect(cartPanel).toBeHidden({ timeout: 3000 });
});

test('mobile: assistant left-anchored, no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://eukolaki.gr:${port}/?skipIntro=1`);
  await page.waitForLoadState('networkidle');

  const fab = page.locator('#thrc-chat-fab');
  await expect(fab).toBeVisible({ timeout: 5000 });
  const fabBox = await fab.boundingBox();
  expect(fabBox.x).toBeLessThan(80);

  const scrollBefore = await page.evaluate(() => document.documentElement.scrollWidth);

  await fab.click();
  const panel = page.locator('#thrc-chat-panel');
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(395);

  const scrollAfter = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollAfter).toBeLessThanOrEqual(scrollBefore);

  const cart = page.locator('#floating-cart');
  await cart.click({ force: true });
  await expect(page.locator('#cart-panel')).toBeVisible({ timeout: 3000 });
  await expect(panel).toBeHidden();
});
