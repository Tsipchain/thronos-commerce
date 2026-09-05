const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
});

test('clean mobile header protects controls from horizontal overflow', () => {
  assert.match(index, /@media \(max-width:600px\)[\s\S]*body\.eko-header-clean \.header-main-row \{[^}]*overflow:hidden/);
  assert.match(index, /body\.eko-header-clean \.eko-header-search \{ display:none/);
});
