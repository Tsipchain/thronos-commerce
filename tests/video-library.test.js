const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { getCustomerSubscriptionStatus } = require('../lib/subscription-status');
const { createVideoStorage, safeKey } = require('../lib/video-storage');

const root = path.join(__dirname, '..');
function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: { Host: options.host || 'eukolaki.gr', ...(options.headers || {}) } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); if (options.body) req.write(options.body); req.end();
  });
}
function formHeaders(body, cookie) { return { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }; }

test('canonical subscriber status handles active, expired and cancelled records', () => {
  const now = '2026-01-10T00:00:00.000Z';
  assert.equal(getCustomerSubscriptionStatus({ subscription: { status: 'active', expiresAt: '2026-02-01' } }, { id: 'a' }, now).status, 'active');
  assert.equal(getCustomerSubscriptionStatus({ subscription: { status: 'active', expiresAt: '2026-01-01' } }, { id: 'a' }, now).status, 'expired');
  assert.equal(getCustomerSubscriptionStatus({ subscription: { status: 'cancelled' } }, { id: 'a' }, now).status, 'cancelled');
  assert.equal(getCustomerSubscriptionStatus({}, { id: 'a' }, now).status, 'none');
});

test('video storage keys reject path traversal', () => {
  assert.throws(() => safeKey('../secret.mp4'));
  assert.throws(() => safeKey('/absolute/video.mp4'));
  assert.equal(safeKey('vid_1/tutorial.webm'), 'vid_1/tutorial.webm');
});

test('local video provider stores outside public media and deletes safely', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-storage-'));
  const source = path.join(rootDir, 'upload.tmp');
  fs.writeFileSync(source, 'video bytes');
  const provider = createVideoStorage({ provider: 'local', localRoot: path.join(rootDir, 'private') });
  await provider.put({ key: 'tenant-video/file.mp4', filePath: source, contentType: 'video/mp4' });
  assert.equal(fs.readFileSync(provider.localPath('tenant-video/file.mp4'), 'utf8'), 'video bytes');
  await provider.remove('tenant-video/file.mp4');
  assert.equal(fs.existsSync(provider.localPath('tenant-video/file.mp4')), false);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('video CRUD, subscriber access and tenant isolation', { timeout: 25000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-library-'));
  fs.cpSync(path.join(root, 'data'), tempRoot, { recursive: true });
  const tenantsFile = path.join(tempRoot, 'tenants.json');
  const tenants = JSON.parse(fs.readFileSync(tenantsFile, 'utf8'));
  tenants.find((tenant) => tenant.id === 'eukolakis').adminPasswordHash = bcrypt.hashSync('video-admin', 4);
  fs.writeFileSync(tenantsFile, JSON.stringify(tenants, null, 2));
  const passwordHash = bcrypt.hashSync('customer-pass', 4);
  const users = [
    { id: 'active-user', name: 'Active Person', email: 'active@example.test', passwordHash, createdAt: '2025-01-01', subscription: { plan: 'Video Club', status: 'active', startsAt: '2025-01-01', expiresAt: '2099-01-01' }, paymentCardNumber: 'SHOULD_NOT_RENDER' },
    { id: 'expired-user', name: 'Expired Person', email: 'expired@example.test', passwordHash, createdAt: '2025-01-01', subscription: { plan: 'Video Club', status: 'active', startsAt: '2025-01-01', expiresAt: '2025-02-01' } }
  ];
  fs.writeFileSync(path.join(tempRoot, 'tenants/eukolakis/users.json'), JSON.stringify(users, null, 2));
  fs.writeFileSync(path.join(tempRoot, 'tenants/demo/users.json'), JSON.stringify([{ id: 'other-user', email: 'other-tenant@example.test', passwordHash, subscription: { status: 'active', expiresAt: '2099-01-01' } }], null, 2));
  fs.writeFileSync(path.join(tempRoot, 'tenants/eukolakis/videos.json'), JSON.stringify([
    { id: 'public-video', tenantId: 'eukolakis', slug: 'public-guide', titleEl: 'Δημόσιος οδηγός', sourceType: 'external', externalVideoUrl: 'https://video.example/public', accessLevel: 'public', published: true },
    { id: 'private-video', tenantId: 'eukolakis', slug: 'subscriber-guide', titleEl: 'Ιδιωτικός οδηγός', sourceType: 'external', externalVideoUrl: 'https://private.example/secret-stream', accessLevel: 'subscriber', published: true }
  ], null, 2));
  fs.writeFileSync(path.join(tempRoot, 'tenants/demo/videos.json'), JSON.stringify([{ id: 'other', tenantId: 'demo', slug: 'other-tenant-video', titleEn: 'Other tenant', sourceType: 'external', externalVideoUrl: 'https://example.test/other', accessLevel: 'public', published: true }], null, 2));
  const port = 35000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', THRC_DATA_ROOT: tempRoot, SESSION_SECRET: 'video-test-secret', THRONOS_ROOT_ADMIN_PASSWORD: 'root-test', VIDEO_STORAGE_PROVIDER: 'local' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`startup timeout: ${errors}`)), 8000); child.stdout.on('data', (chunk) => { if (String(chunk).includes(`listening on port ${port}`)) { clearTimeout(timer); resolve(); } }); child.once('exit', (code) => reject(new Error(`server exited ${code}: ${errors}`))); });
    const library = await request(port, '/content');
    assert.equal(library.status, 200);
    assert.match(library.body, /public-guide/);
    assert.match(library.body, /subscriber-guide/);
    assert.doesNotMatch(library.body, /other-tenant-video/);
    const publicPage = await request(port, '/content/public-guide');
    assert.equal(publicPage.status, 200);
    assert.match(publicPage.body, /https:\/\/video\.example\/public/);
    const anonymousPrivate = await request(port, '/content/subscriber-guide');
    assert.equal(anonymousPrivate.status, 403);
    assert.doesNotMatch(anonymousPrivate.body, /private\.example\/secret-stream/);

    const expiredBody = new URLSearchParams({ email: 'expired@example.test', password: 'customer-pass' }).toString();
    const expiredLogin = await request(port, '/login', { method: 'POST', body: expiredBody, headers: formHeaders(expiredBody) });
    const expiredCookie = expiredLogin.headers['set-cookie'][0].split(';')[0];
    const expiredPrivate = await request(port, '/content/subscriber-guide', { headers: { Cookie: expiredCookie } });
    assert.equal(expiredPrivate.status, 403);
    assert.doesNotMatch(expiredPrivate.body, /private\.example\/secret-stream/);

    const activeBody = new URLSearchParams({ email: 'active@example.test', password: 'customer-pass' }).toString();
    const activeLogin = await request(port, '/login', { method: 'POST', body: activeBody, headers: formHeaders(activeBody) });
    const activeCookie = activeLogin.headers['set-cookie'][0].split(';')[0];
    const activePrivate = await request(port, '/content/subscriber-guide', { headers: { Cookie: activeCookie } });
    assert.equal(activePrivate.status, 200);
    assert.match(activePrivate.body, /private\.example\/secret-stream/);

    const adminBody = 'password=video-admin';
    const adminLogin = await request(port, '/admin/login', { method: 'POST', body: adminBody, headers: formHeaders(adminBody) });
    const adminCookie = adminLogin.headers['set-cookie'][0].split(';')[0];
    const adminVideos = await request(port, '/admin/videos', { headers: { Cookie: adminCookie } });
    assert.equal(adminVideos.status, 200);
    assert.doesNotMatch(adminVideos.body, /other-tenant-video/);
    const createBody = new URLSearchParams({ titleEl: 'Νέο βίντεο', titleEn: 'New video', slug: 'new-video', sourceType: 'external', externalVideoUrl: 'https://video.example/new', accessLevel: 'subscriber', published: '1', featured: '1', sortOrder: '4' }).toString();
    const created = await request(port, '/admin/videos/save', { method: 'POST', body: createBody, headers: formHeaders(createBody, adminCookie) });
    assert.equal(created.status, 302, errors);
    let stored = JSON.parse(fs.readFileSync(path.join(tempRoot, 'tenants/eukolakis/videos.json'), 'utf8'));
    const newVideo = stored.find((video) => video.slug === 'new-video');
    assert.ok(newVideo);
    const updateBody = new URLSearchParams({ id: newVideo.id, titleEl: 'Νέο βίντεο', slug: 'new-video', sourceType: 'external', externalVideoUrl: 'https://video.example/newer', accessLevel: 'public', sortOrder: '2' }).toString();
    const updated = await request(port, '/admin/videos/save', { method: 'POST', body: updateBody, headers: formHeaders(updateBody, adminCookie) });
    assert.equal(updated.status, 302, errors);
    stored = JSON.parse(fs.readFileSync(path.join(tempRoot, 'tenants/eukolakis/videos.json'), 'utf8'));
    assert.equal(stored.find((video) => video.id === newVideo.id).published, false);
    const subscribers = await request(port, '/admin/subscribers?status=active', { headers: { Cookie: adminCookie } });
    assert.equal(subscribers.status, 200);
    assert.match(subscribers.body, /active@example\.test/);
    assert.doesNotMatch(subscribers.body, /expired@example\.test/);
    assert.doesNotMatch(subscribers.body, /other-tenant@example\.test/);
    assert.doesNotMatch(subscribers.body, /SHOULD_NOT_RENDER/);
    const deleteBody = '';
    const deleted = await request(port, `/admin/videos/${newVideo.id}/delete`, { method: 'POST', body: deleteBody, headers: formHeaders(deleteBody, adminCookie) });
    assert.equal(deleted.status, 302, errors);
    stored = JSON.parse(fs.readFileSync(path.join(tempRoot, 'tenants/eukolakis/videos.json'), 'utf8'));
    assert.equal(stored.some((video) => video.id === newVideo.id), false);
  } finally { child.kill('SIGTERM'); fs.rmSync(tempRoot, { recursive: true, force: true }); }
});
