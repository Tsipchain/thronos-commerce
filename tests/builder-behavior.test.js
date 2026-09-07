const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');

const root = path.join(__dirname, '..');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: { Host: 'eukolaki.gr', ...(options.headers || {}) } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
function form(body, cookie) {
  return { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...(cookie ? { Cookie: cookie } : {}) };
}
function checkoutBody(items) {
  return new URLSearchParams({
    name: 'Builder Test', email: 'builder@example.test', phone: '2100000000', address: 'Test 1', city: 'Athens', tk: '10000',
    shippingMethodId: 'standard_cod', paymentMethodId: 'COD', cartJson: JSON.stringify(items)
  }).toString();
}

async function startFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-behavior-'));
  fs.cpSync(path.join(root, 'data'), tempRoot, { recursive: true });
  const tenantsFile = path.join(tempRoot, 'tenants.json');
  const tenants = JSON.parse(fs.readFileSync(tenantsFile, 'utf8'));
  tenants.find((tenant) => tenant.id === 'eukolakis').adminPasswordHash = bcrypt.hashSync('builder-admin', 4);
  fs.writeFileSync(tenantsFile, JSON.stringify(tenants, null, 2));
  const productsFile = path.join(tempRoot, 'tenants/eukolakis/products.json');
  const products = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
  const roll = products.find((product) => product.id === 'eukolaki-diy-roll-kit');
  roll.kitOptions[0].choices[2].enabled = false;
  fs.writeFileSync(productsFile, JSON.stringify(products, null, 2));
  const configFile = path.join(tempRoot, 'tenants/eukolakis/config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.homepage.heroImage = '/hero-A.jpg';
  config.homepage.introImage = '/intro-B.jpg';
  config.homepage.introImageSource = 'dedicated';
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  const port = 36000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', THRC_DATA_ROOT: tempRoot, SESSION_SECRET: 'builder-test-secret', THRONOS_ROOT_ADMIN_PASSWORD: 'root-test', EMAIL_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${errors}`)), 8000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes(`listening on port ${port}`)) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => reject(new Error(`server exited ${code}: ${errors}`)));
  });
  return { tempRoot, productsFile, configFile, port, child, errors: () => errors };
}

const selections = [
  { groupId: 'tampakiera-karoulaki', choiceId: 'tamp-white' },
  { groupId: 'dexia-plevra', choiceId: 'right-disc-145' },
  { groupId: 'tirantes', choiceId: 'strap-plain' }
];

test('builder checkout security, canonical snapshots, persistence, intro separation, and classic regression', { timeout: 30000 }, async (t) => {
  const fixture = await startFixture();
  const { port, productsFile, configFile, child } = fixture;
  try {
    await t.test('rejects a disabled option', async () => {
      const body = checkoutBody([{ id: 'eukolaki-diy-roll-kit', qty: 1, isKitSummary: true, selectedOptions: [{ groupId: 'tampakiera-karoulaki', choiceId: 'tamp-black' }] }]);
      const response = await request(port, '/checkout', { method: 'POST', body, headers: form(body) });
      assert.equal(response.status, 400);
      assert.match(response.body, /Disabled builder option/);
    });
    await t.test('rejects unknown step and option IDs', async () => {
      for (const selectedOptions of [
        [{ groupId: 'forged-step', choiceId: 'tamp-white' }],
        [{ groupId: 'tampakiera-karoulaki', choiceId: 'forged-option' }]
      ]) {
        const body = checkoutBody([{ id: 'eukolaki-diy-roll-kit', isKitSummary: true, selectedOptions }]);
        const response = await request(port, '/checkout', { method: 'POST', body, headers: form(body) });
        assert.equal(response.status, 400);
        assert.match(response.body, /Unknown builder (step|option)/);
      }
    });
    let purchasedOrder;
    await t.test('ignores forged totals and writes a complete canonical builder snapshot', async () => {
      const forged = { id: 'eukolaki-diy-roll-kit', qty: 1, price: 0.01, total: 0.01, finalUnitPrice: 0.01, isKitSummary: true, selectedOptions: selections.map((entry) => ({ ...entry, choiceLabel: 'FORGED', priceDelta: -999 })) };
      const body = checkoutBody([forged]);
      const response = await request(port, '/checkout', { method: 'POST', body, headers: form(body) });
      assert.equal(response.status, 303, fixture.errors());
      const orders = JSON.parse(fs.readFileSync(path.join(fixture.tempRoot, 'tenants/eukolakis/orders.json'), 'utf8'));
      purchasedOrder = orders.at(-1);
      const item = purchasedOrder.items.find((entry) => entry.id === 'eukolaki-diy-roll-kit');
      assert.equal(item.builderType, 'step_by_step');
      assert.equal(item.builderSnapshot.total, 14.5);
      assert.equal(item.builderSnapshot.steps.length, 5);
      assert.deepEqual(item.builderSnapshot.steps.map((step) => step.skipped), [false, true, false, false, true]);
      assert.equal(item.builderSnapshot.steps[0].optionTitle, 'Λευκό');
      assert.equal(item.builderSnapshot.steps[0].linePrice, 8);
      assert.notEqual(purchasedOrder.total, 0.01);
      assert.doesNotMatch(JSON.stringify(item.builderSnapshot), /FORGED|-999/);
    });
    await t.test('cart snapshot session fallback preserves configured kit data through canonical checkout', async () => {
      const clientSnapshot = {
        version: 1,
        builderType: 'step_by_step',
        baseProductId: 'eukolaki-diy-roll-kit',
        steps: [{ stepId: 'forged-client-label', stepTitle: 'FORGED CLIENT LABEL', skipped: false }],
        total: 0.01
      };
      const snapshotBody = JSON.stringify({ items: [{ id: 'eukolaki-diy-roll-kit', qty: 1, isKitSummary: true, builderType: 'step_by_step', builderSnapshot: clientSnapshot, selectedOptions: selections }] });
      const saved = await request(port, '/api/checkout/cart-snapshot', { method: 'POST', body: snapshotBody, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(snapshotBody) } });
      assert.equal(saved.status, 200);
      const cookie = saved.headers['set-cookie'][0].split(';')[0];
      const body = checkoutBody([]);
      const checkedOut = await request(port, '/checkout', { method: 'POST', body, headers: form(body, cookie) });
      assert.equal(checkedOut.status, 303, fixture.errors());
      const order = JSON.parse(fs.readFileSync(path.join(fixture.tempRoot, 'tenants/eukolakis/orders.json'), 'utf8')).at(-1);
      const canonical = order.items.find((item) => item.builderSnapshot).builderSnapshot;
      assert.equal(canonical.steps.length, 5);
      assert.equal(canonical.total, 14.5);
      assert.doesNotMatch(JSON.stringify(canonical), /FORGED CLIENT LABEL|forged-client-label/);
    });
    await t.test('historical order snapshot survives builder mutation', () => {
      const original = structuredClone(purchasedOrder.items.find((entry) => entry.builderSnapshot).builderSnapshot);
      const products = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
      const roll = products.find((product) => product.id === 'eukolaki-diy-roll-kit');
      roll.kitOptions[0].choices[0].label.el = 'ΝΕΟ ΟΝΟΜΑ';
      roll.kitOptions[0].choices[0].priceDelta = 999;
      roll.kitOptions.reverse();
      fs.writeFileSync(productsFile, JSON.stringify(products, null, 2));
      const storedOrder = JSON.parse(fs.readFileSync(path.join(fixture.tempRoot, 'tenants/eukolakis/orders.json'), 'utf8')).find((order) => order.id === purchasedOrder.id);
      assert.deepEqual(storedOrder.items.find((entry) => entry.builderSnapshot).builderSnapshot, original);
    });
    await t.test('Admin reorder/delete/save/reload preserves surviving stable IDs', async () => {
      const loginBody = new URLSearchParams({ password: 'builder-admin' }).toString();
      const login = await request(port, '/admin/login', { method: 'POST', body: loginBody, headers: form(loginBody) });
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const products = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
      const roll = products.find((product) => product.id === 'eukolaki-diy-roll-kit');
      const deletedStepId = roll.kitOptions[1].id;
      const survivingStepIds = roll.kitOptions.map((step) => step.id).filter((id) => id !== deletedStepId).reverse();
      roll.kitOptions = roll.kitOptions.filter((step) => step.id !== deletedStepId).reverse();
      const first = roll.kitOptions[0];
      const deletedOptionId = first.choices[0].id;
      const survivingOptionIds = first.choices.slice(1).map((choice) => choice.id).reverse();
      first.choices = first.choices.slice(1).reverse();
      const saveBody = new URLSearchParams({ productsJson: JSON.stringify(products) }).toString();
      const saved = await request(port, '/admin/products', { method: 'POST', body: saveBody, headers: form(saveBody, cookie) });
      assert.equal(saved.status, 200, fixture.errors());
      const reloaded = JSON.parse(fs.readFileSync(productsFile, 'utf8')).find((product) => product.id === roll.id);
      assert.deepEqual(reloaded.kitOptions.map((step) => step.id), survivingStepIds);
      assert.equal(reloaded.kitOptions.some((step) => step.id === deletedStepId), false);
      assert.deepEqual(reloaded.kitOptions[0].choices.map((choice) => choice.id), survivingOptionIds);
      assert.equal(reloaded.kitOptions[0].choices.some((choice) => choice.id === deletedOptionId), false);
    });
    await t.test('classic Slide Door builder still renders and accepts canonical checkout pricing', async () => {
      const storefront = await request(port, '/?skipIntro=1');
      assert.equal(storefront.status, 200);
      assert.match(storefront.body, /eukolaki-diy-slide-door-kit/);
      const body = checkoutBody([{ id: 'eukolaki-diy-slide-door-kit', qty: 1, price: 0.01, selectedOptions: [{ groupId: 'finish', choiceId: 'matte-black' }] }]);
      const response = await request(port, '/checkout', { method: 'POST', body, headers: form(body) });
      assert.equal(response.status, 303, fixture.errors());
      const order = JSON.parse(fs.readFileSync(path.join(fixture.tempRoot, 'tenants/eukolakis/orders.json'), 'utf8')).at(-1);
      assert.equal(order.items[0].builderType, undefined);
      assert.equal(order.items[0].price, 2.5);
    });
    await t.test('intro dedicated and logo modes never inherit hero', async () => {
      let intro = await request(port, '/intro');
      assert.equal(intro.status, 200);
      assert.match(intro.body, /\/intro-B\.jpg/);
      assert.doesNotMatch(intro.body, /\/hero-A\.jpg/);
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      config.homepage.introImageSource = 'logo';
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      intro = await request(port, '/intro');
      assert.match(intro.body, /\/logo\.svg/);
      assert.doesNotMatch(intro.body, /\/intro-B\.jpg|\/hero-A\.jpg/);
    });
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});
