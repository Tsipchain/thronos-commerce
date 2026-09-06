const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('views/index.ejs');
const product = read('views/product.ejs');
const admin = read('views/admin.ejs');
const server = read('server.js');
const eukolakis = JSON.parse(read('data/tenants/eukolakis/config.json'));

test('Eukolakis selects the clean header by default', () => {
  assert.equal(eukolakis.theme.headerMenuStyle, 'clean');
  assert.match(server, /\['clean', 'industrial_plates'\]/);
});

test('admin can select and persist either header style', () => {
  assert.match(admin, /name="themeHeaderMenuStyle"/);
  assert.match(admin, /value="industrial_plates"/);
  assert.match(server, /config\.theme\.headerMenuStyle\s*=/);
});

test('clean header disables header watermark and visible auth buttons', () => {
  assert.match(index, /isEukolakisClassic && !isCleanHeader/);
  assert.match(index, /if \(!isCleanHeader\).*header-auth-actions/s);
  assert.match(index, /eko-header-icon-btn[\s\S]*user \? '\/account' : '\/login'/);
});

test('homepage has separate admin-driven hero and account utility', () => {
  assert.match(index, /class="eko-hero-img" src="<%= homepage\.heroImage %>"/);
  assert.match(index, /class="eko-account-utility"/);
  assert.ok(index.indexOf('class="eko-account-utility"') < index.indexOf('class="store-footer"'));
});

test('category and kit image slots remain data-driven', () => {
  assert.match(index, /class="eko-cat-tile-img" src="<%= cat\.image %>"/);
  assert.match(index, /<img src="<%= product\.imageUrl %>"/);
});

test('empty DIY projects section is hidden and admin exposes a project flag', () => {
  assert.match(index, /const showProjectsSection = diyProjects\.length > 0/);
  assert.match(admin, /id="f-diy-project"/);
  assert.match(admin, /diyProject:\s+fDiyProject/);
});

test('homepage and product templates share clean header scoping', () => {
  assert.match(index, /eko-header-.*headerMenuStyle/);
  assert.match(product, /eko-header-.*headerMenuStyle/);
  assert.match(index, /body\.eko-header-clean .*::before/);
  assert.match(product, /body\.eko-header-clean .*::before/);
  assert.match(index, /body\.eukolakis-classic\.eko-header-clean \.store-header \{ position:static; top:auto; display:grid;/);
  assert.match(product, /body\.eukolakis-classic\.eko-header-clean \.store-header \{ position:static; top:auto; display:grid;/);
  assert.match(product, /id="menu-toggle"/);
  assert.doesNotMatch(index, /body\.eko-header-clean \.header-nav-row \{[^}]*margin:-/);
  assert.doesNotMatch(product, /body\.eko-header-clean \.header-nav-row \{[^}]*margin:-/);
});

test('clean mobile header protects controls from horizontal overflow', () => {
  assert.match(index, /@media \(max-width:900px\)[\s\S]*body\.eko-header-clean \.main-nav \{ display:none/);
  assert.match(index, /body\.eko-header-clean \.eko-header-search \{ display:none/);
  assert.match(index, /aria-expanded="false" aria-controls="main-nav"/);
  assert.match(index, /event\.key === "Escape"/);
  assert.match(product, /event\.key === 'Escape'/);
  assert.doesNotMatch(index, /body\.eko-header-clean[^\n]*overflow-x:auto/);
});

test('category CTAs and clean navigation share the polished components', () => {
  assert.match(index, /\.eko-cat-tile-cta \{[\s\S]*width:calc\(100% - 32px\)[\s\S]*margin: auto 16px 14px/);
  assert.match(index, /\.eko-cat-tile:hover \.eko-cat-tile-cta svg[^{]*\{ transform:translateX\(3px\)/);
  assert.match(index, /class="eko-cat-tile eko-subscription-video-card"[\s\S]*class="eko-cat-tile-cta"/);
  assert.match(index, /li class="<%= !activeCategory \? 'active' : '' %>"/);
  assert.match(product, /product\.categoryId === cat\.id[^?]*\? 'active'/);
  assert.match(index, /li\.active a::after \{ width:100%; opacity:1; \}/);
});

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname,
      method: options.method || 'GET',
      headers: { Host: options.host || 'eukolaki.gr', ...(options.headers || {}) }
    }, (res) => {
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

test('storefront and admin preserve independent category visibility behavior', { timeout: 20000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolakis-parity-'));
  fs.cpSync(path.join(root, 'data'), tempRoot, { recursive: true });
  const categoriesPath = path.join(tempRoot, 'tenants/eukolakis/categories.json');
  const configPath = path.join(tempRoot, 'tenants/eukolakis/config.json');
  const tenantsPath = path.join(tempRoot, 'tenants.json');
  const categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
  const hidden = categories[0];
  hidden.visible = false;
  hidden.showInMainNav = true;
  fs.writeFileSync(categoriesPath, JSON.stringify(categories, null, 2));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.homepage.introEnabled = false;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const tenants = JSON.parse(fs.readFileSync(tenantsPath, 'utf8'));
  tenants.find((tenant) => tenant.id === 'eukolakis').adminPasswordHash = bcrypt.hashSync('parity-test', 4);
  fs.writeFileSync(tenantsPath, JSON.stringify(tenants, null, 2));

  const port = 34000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', THRC_DATA_ROOT: tempRoot,
      SESSION_SECRET: 'parity-session-secret', THRONOS_ROOT_ADMIN_PASSWORD: 'parity-root' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverErrors = '';
  child.stderr.on('data', (chunk) => { serverErrors += String(chunk); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 8000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes(`listening on port ${port}`)) { clearTimeout(timer); resolve(); }
      });
      child.once('exit', (code) => reject(new Error(`server exited early: ${code}`)));
    });

    const home = await request(port, '/?skipIntro=1');
    assert.equal(home.status, 200);
    assert.match(home.body, new RegExp(`category=${hidden.slug}`), 'hidden card remains in navigation');
    assert.doesNotMatch(home.body, new RegExp(`data-cat-id="${hidden.id}"`), 'hidden card is omitted');
    assert.match(home.body, /eko-header-clean/);

    const productId = JSON.parse(fs.readFileSync(path.join(tempRoot, 'tenants/eukolakis/products.json'), 'utf8'))[0].id;
    const productPage = await request(port, `/product/${productId}`);
    assert.equal(productPage.status, 200);
    assert.match(productPage.body, /id="menu-toggle"/);
    assert.ok(productPage.body.indexOf('class="eko-account-utility"') < productPage.body.indexOf('class="store-footer"'));

    const demo = await request(port, '/?skipIntro=1', { host: 'demo.thronoscommerce.local' });
    assert.equal(demo.status, 200);
    assert.doesNotMatch(demo.body, /<body[^>]*eko-header-clean/);

    const loginBody = 'password=parity-test';
    const login = await request(port, '/admin/login', { method: 'POST', body: loginBody,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(loginBody) } });
    assert.equal(login.status, 302);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const subscriptionSettings = new URLSearchParams({ password: 'parity-test', homepageShowSubscriptionsCard: '1',
      homepageSubscriptionVideoImage: '/subscription-test.jpg',
      homepageSubscriptionVideoTitle_el: 'Συνδρομητικά βίντεο δοκιμής', homepageSubscriptionVideoTitle_en: 'Test subscription videos',
      homepageSubscriptionVideoSubtitle_el: 'Οδηγοί δοκιμής', homepageSubscriptionVideoSubtitle_en: 'Test guides',
      homepageSubscriptionVideoHref: '/content', homepageSubscriptionVideoCtaLabel_el: 'ΔΕΣ ΤΑ ΒΙΝΤΕΟ',
      homepageSubscriptionVideoCtaLabel_en: 'SEE VIDEOS' }).toString();
    const settingsSave = await request(port, '/admin/settings', { method: 'POST', body: subscriptionSettings,
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(subscriptionSettings) } });
    assert.equal(settingsSave.status, 200, serverErrors || settingsSave.body.slice(0, 500));
    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(savedConfig.homepage.subscriptionVideoCard.image, '/subscription-test.jpg');
    assert.equal(savedConfig.homepage.subscriptionVideoCard.href, '/content');
    const homeWithSubscription = await request(port, '/?skipIntro=1');
    assert.match(homeWithSubscription.body, /data-special-card="subscription-videos"/);
    assert.match(homeWithSubscription.body, /src="\/subscription-test\.jpg"/);
    assert.match(homeWithSubscription.body, /href="\/content[^\"]*"[^>]*>ΣΥΝΔΡΟΜΗΤΙΚΑ ΒΙΝΤΕΟ/);
    const categorySection = homeWithSubscription.body.match(/<section class="eko-cat-section">[\s\S]*?<\/section>/)[0];
    const cardCount = (categorySection.match(/<a class="eko-cat-tile/g) || []).length;
    const ctaCount = (categorySection.match(/<div class="eko-cat-tile-cta"/g) || []).length;
    assert.equal(ctaCount, cardCount, 'every rendered category card uses the shared CTA');

    const disableSettings = new URLSearchParams({ password: 'parity-test', homepageShowSubscriptionsCard: '0' }).toString();
    const disableSave = await request(port, '/admin/settings', { method: 'POST', body: disableSettings,
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(disableSettings) } });
    assert.equal(disableSave.status, 200, serverErrors || disableSave.body.slice(0, 500));
    const homeWithoutSubscription = await request(port, '/?skipIntro=1');
    assert.doesNotMatch(homeWithoutSubscription.body, /data-special-card="subscription-videos"/);

    const updateBody = new URLSearchParams({ password: 'parity-test', categoryId: hidden.id,
      name_el: typeof hidden.name === 'object' ? hidden.name.el : hidden.name,
      name_en: typeof hidden.name === 'object' ? hidden.name.en || '' : '',
      slug: hidden.slug, navOrder: String(hidden.navOrder || 0), showInMainNav: 'on' }).toString();
    const update = await request(port, '/admin/categories/update', { method: 'POST', body: updateBody,
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(updateBody) } });
    assert.equal(update.status, 200, serverErrors || update.body.slice(0, 500));
    const persisted = JSON.parse(fs.readFileSync(categoriesPath, 'utf8')).find((category) => category.id === hidden.id);
    assert.equal(persisted.visible, false);
    assert.equal(persisted.showInMainNav, true);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
