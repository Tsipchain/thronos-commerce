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
const { activatePaidSubscription, applyManualSubscriptionAction } = require('../lib/customer-subscriptions');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
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

test('verified subscription purchase activates once and payment replay is idempotent', () => {
  const customers = [{ id: 'buyer', email: 'buyer@example.test' }];
  const order = { id: 'paid-order-1', email: 'buyer@example.test', paymentStatus: 'PAID', items: [{ id: 'video-plan', qty: 1 }] };
  const products = [{ id: 'video-plan', subscriptionPlan: 'Video Club 30', subscriptionDurationDays: 30 }];
  const first = activatePaidSubscription(customers, order, products, '2026-01-01T00:00:00Z');
  assert.equal(first.activated, true);
  const expiry = customers[0].subscription.expiresAt;
  const replay = activatePaidSubscription(customers, order, products, '2026-01-02T00:00:00Z');
  assert.equal(replay.reason, 'already_processed');
  assert.equal(customers[0].subscription.expiresAt, expiry);
  assert.equal(customers[0].subscriptionHistory.length, 1);
  assert.equal(activatePaidSubscription(customers, { ...order, id: 'pending', paymentStatus: 'PENDING_STRIPE' }, products).reason, 'unverified_payment');
  assert.match(serverSource, /payment_status !== 'paid'[\s\S]*order\.paymentStatus\s*=\s*'PAID'[\s\S]*activateCustomerSubscriptionForPaidOrder\(req, order\)/);
});

test('manual subscription grant, extension, cancellation and reactivation retain history', () => {
  const customer = { id: 'manual', email: 'manual@example.test' };
  applyManualSubscriptionAction(customer, { action: 'grant', plan: 'Club', durationDays: 30 }, '2026-01-01T00:00:00Z');
  assert.equal(customer.subscription.status, 'active');
  const grantedExpiry = customer.subscription.expiresAt;
  applyManualSubscriptionAction(customer, { action: 'extend', durationDays: 30 }, '2026-01-02T00:00:00Z');
  assert.ok(new Date(customer.subscription.expiresAt) > new Date(grantedExpiry));
  applyManualSubscriptionAction(customer, { action: 'cancel' }, '2026-01-03T00:00:00Z');
  assert.equal(customer.subscription.status, 'cancelled');
  applyManualSubscriptionAction(customer, { action: 'reactivate', expiresAt: '2026-12-31' }, '2026-01-04T00:00:00Z');
  assert.equal(customer.subscription.status, 'active');
  assert.equal(customer.subscriptionHistory.length, 4);
  assert.ok(customer.subscriptionHistory.every((entry) => entry.source === 'admin_manual'));
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
    { id: 'expired-user', name: 'Expired Person', email: 'expired@example.test', passwordHash, createdAt: '2025-01-01', subscription: { plan: 'Video Club', status: 'active', startedAt: '2025-01-01', expiresAt: '2025-02-01' } },
    { id: 'cancelled-user', name: 'Cancelled Person', email: 'cancelled@example.test', passwordHash, createdAt: '2025-01-01', subscription: { plan: 'Video Club', status: 'cancelled', startedAt: '2025-01-01', cancelledAt: '2025-02-01', expiresAt: '2099-01-01' } }
  ];
  fs.writeFileSync(path.join(tempRoot, 'tenants/eukolakis/users.json'), JSON.stringify(users, null, 2));
  fs.writeFileSync(path.join(tempRoot, 'tenants/demo/users.json'), JSON.stringify([{ id: 'other-user', email: 'other-tenant@example.test', passwordHash, subscription: { status: 'active', expiresAt: '2099-01-01' } }], null, 2));
  fs.writeFileSync(path.join(tempRoot, 'tenants/eukolakis/videos.json'), JSON.stringify([
    { id: 'public-video', tenantId: 'eukolakis', slug: 'public-guide', titleEl: 'Δημόσιος οδηγός', sourceType: 'external', externalVideoUrl: 'https://video.example/public', accessLevel: 'public', published: true },
    { id: 'private-video', tenantId: 'eukolakis', slug: 'subscriber-guide', titleEl: 'Ιδιωτικός οδηγός', sourceType: 'external', externalVideoUrl: 'https://private.example/secret-stream', accessLevel: 'subscriber', published: true },
    { id: 'uploaded-video', tenantId: 'eukolakis', slug: 'uploaded-guide', titleEl: 'Uploaded οδηγός', sourceType: 'uploaded', videoStorageKey: 'uploaded-video/sample.mp4', accessLevel: 'subscriber', published: true }
  ], null, 2));
  const videoBytes = Buffer.alloc(2048, 7);
  fs.mkdirSync(path.join(tempRoot, 'tenants/eukolakis/video-storage/uploaded-video'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'tenants/eukolakis/video-storage/uploaded-video/sample.mp4'), videoBytes);
  const productsFile = path.join(tempRoot, 'tenants/eukolakis/products.json');
  const products = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
  products.push({ id: 'legacy-digital', name: 'Legacy digital', price: 10, active: true, hasDigitalContent: true, videoUrl: 'https://video.example/legacy.mp4' });
  fs.writeFileSync(productsFile, JSON.stringify(products, null, 2));
  fs.writeFileSync(path.join(tempRoot, 'tenants/eukolakis/orders.json'), JSON.stringify([{ id: 'legacy-order-1', email: 'active@example.test', userEmail: 'active@example.test', paymentStatus: 'PAID', items: [{ id: 'legacy-digital', qty: 1 }] }], null, 2));
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

    const cancelledBody = new URLSearchParams({ email: 'cancelled@example.test', password: 'customer-pass' }).toString();
    const cancelledLogin = await request(port, '/login', { method: 'POST', body: cancelledBody, headers: formHeaders(cancelledBody) });
    const cancelledCookie = cancelledLogin.headers['set-cookie'][0].split(';')[0];
    const cancelledPrivate = await request(port, '/content/subscriber-guide', { headers: { Cookie: cancelledCookie } });
    assert.equal(cancelledPrivate.status, 403);
    assert.doesNotMatch(cancelledPrivate.body, /private\.example\/secret-stream/);

    const activeBody = new URLSearchParams({ email: 'active@example.test', password: 'customer-pass' }).toString();
    const activeLogin = await request(port, '/login', { method: 'POST', body: activeBody, headers: formHeaders(activeBody) });
    const activeCookie = activeLogin.headers['set-cookie'][0].split(';')[0];
    const activePrivate = await request(port, '/content/subscriber-guide', { headers: { Cookie: activeCookie } });
    assert.equal(activePrivate.status, 200);
    assert.match(activePrivate.body, /private\.example\/secret-stream/);
    const range = await request(port, '/content/uploaded-guide/stream', { headers: { Cookie: activeCookie, Range: 'bytes=0-1023' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-range'], 'bytes 0-1023/2048');
    assert.equal(range.headers['accept-ranges'], 'bytes');
    assert.equal(Number(range.headers['content-length']), 1024);
    assert.equal(range.headers['content-type'], 'video/mp4');
    const invalidRange = await request(port, '/content/uploaded-guide/stream', { headers: { Cookie: activeCookie, Range: 'bytes=3000-4000' } });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers['content-range'], 'bytes */2048');
    const anonymousRange = await request(port, '/content/uploaded-guide/stream', { headers: { Range: 'bytes=0-10' } });
    assert.equal(anonymousRange.status, 403);
    assert.doesNotMatch(anonymousRange.body, /video-storage|sample\.mp4/);
    const normalStream = await request(port, '/content/uploaded-guide/stream', { headers: { Cookie: activeCookie } });
    assert.equal(normalStream.status, 200);
    assert.equal(Number(normalStream.headers['content-length']), 2048);
    const legacyContent = await request(port, '/content/legacy-order-1', { headers: { Cookie: activeCookie } });
    assert.equal(legacyContent.status, 200);
    assert.match(legacyContent.body, /Legacy digital/);

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
    for (const operation of [
      { action: 'grant', plan: 'Support Grant', durationDays: '30' },
      { action: 'extend', plan: 'Support Grant', durationDays: '30' },
      { action: 'cancel', plan: 'Support Grant' },
      { action: 'reactivate', plan: 'Support Grant', expiresAt: '2099-12-31' }
    ]) {
      const body = new URLSearchParams(operation).toString();
      const response = await request(port, '/admin/subscribers/expired-user/subscription', { method: 'POST', body, headers: formHeaders(body, adminCookie) });
      assert.equal(response.status, 302, errors);
    }
    const persistedUsers = JSON.parse(fs.readFileSync(path.join(tempRoot, 'tenants/eukolakis/users.json'), 'utf8'));
    const manuallyManaged = persistedUsers.find((user) => user.id === 'expired-user');
    assert.equal(manuallyManaged.subscription.status, 'active');
    assert.equal(manuallyManaged.subscriptionHistory.length, 4);
    assert.deepEqual(manuallyManaged.subscriptionHistory.map((entry) => entry.action), ['grant', 'extend', 'cancel', 'reactivate']);
    const deleteBody = '';
    const deleted = await request(port, `/admin/videos/${newVideo.id}/delete`, { method: 'POST', body: deleteBody, headers: formHeaders(deleteBody, adminCookie) });
    assert.equal(deleted.status, 302, errors);
    stored = JSON.parse(fs.readFileSync(path.join(tempRoot, 'tenants/eukolakis/videos.json'), 'utf8'));
    assert.equal(stored.some((video) => video.id === newVideo.id), false);
  } finally { child.kill('SIGTERM'); fs.rmSync(tempRoot, { recursive: true, force: true }); }
});
