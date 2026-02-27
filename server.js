const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const multer = require('multer');
const bcrypt = require('bcryptjs');

function safeRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}
const nodemailer = safeRequire('nodemailer');

// ── i18n ─────────────────────────────────────────────────────────────────────
const LOCALES_DIR = path.join(__dirname, 'locales');
const SUPPORTED_LANGS = ['el', 'en', 'de', 'es', 'ru', 'ja'];
let LOCALES = {};

function loadLocales() {
  LOCALES = {};
  for (const lang of SUPPORTED_LANGS) {
    try {
      LOCALES[lang] = JSON.parse(
        fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), 'utf8')
      );
    } catch (e) {
      console.warn(`[i18n] Could not load locale ${lang}: ${e.message}`);
      LOCALES[lang] = {};
    }
  }
}

function getLangFromRequest(req) {
  const qLang = (req.query.lang || '').toLowerCase();
  if (SUPPORTED_LANGS.includes(qLang)) return qLang;
  const acceptLang = (req.headers['accept-language'] || '').toLowerCase();
  for (const lang of SUPPORTED_LANGS) {
    if (
      acceptLang.startsWith(lang) ||
      acceptLang.includes(`${lang}-`) ||
      acceptLang.includes(`${lang},`)
    ) {
      return lang;
    }
  }
  return 'el';
}

function translate(lang, key) {
  const parts = key.split('.');
  let val = LOCALES[lang];
  for (const part of parts) {
    if (!val || typeof val !== 'object') { val = undefined; break; }
    val = val[part];
  }
  if (val !== undefined && val !== null) return String(val);
  if (lang !== 'el') return translate('el', key);
  return key;
}

loadLocales();

const app = express();

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Data root config + auto-seeding for volumes
const EMBEDDED_DATA_ROOT = path.join(__dirname, 'data');

function copyDirRecursiveSync(srcDir, destDir) {
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath);
    } else if (entry.isFile()) {
      // μην overwrite αν υπάρχει ήδη
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

let DATA_ROOT = EMBEDDED_DATA_ROOT;

if (process.env.THRC_DATA_ROOT) {
  const candidateRoot = process.env.THRC_DATA_ROOT;

  try {
    ensureDir(candidateRoot);
    const candidateRegistry = path.join(candidateRoot, 'tenants.json');

    if (fs.existsSync(candidateRegistry)) {
      // υπάρχει ήδη tenants.json στο volume → δουλεύουμε από εκεί
      DATA_ROOT = candidateRoot;
      console.log(
        '[Thronos Commerce] Using data root from THRC_DATA_ROOT:',
        candidateRoot
      );
    } else {
      // δεν υπάρχει tenants.json → seed από το embedded ./data
      console.warn(
        '[Thronos Commerce] THRC_DATA_ROOT is set to',
        candidateRoot,
        'but tenants.json is missing – seeding from embedded ./data.'
      );
      copyDirRecursiveSync(EMBEDDED_DATA_ROOT, candidateRoot);
      DATA_ROOT = candidateRoot;
    }
  } catch (err) {
    console.error(
      '[Thronos Commerce] Failed to use THRC_DATA_ROOT, falling back to embedded ./data:',
      err.message
    );
    DATA_ROOT = EMBEDDED_DATA_ROOT;
  }
} else {
  console.log(
    '[Thronos Commerce] THRC_DATA_ROOT not set – using embedded ./data as DATA_ROOT.'
  );
}

// Ensure base dirs for the final DATA_ROOT
ensureDir(DATA_ROOT);

const TENANTS_DIR = path.join(DATA_ROOT, 'tenants');
ensureDir(TENANTS_DIR);

const TENANTS_REGISTRY       = path.join(DATA_ROOT, 'tenants.json');
const REFERRAL_ACCOUNTS_FILE = path.join(DATA_ROOT, 'referral_accounts.json');
const REFERRAL_EARNINGS_FILE = path.join(DATA_ROOT, 'referral_earnings.json');

function loadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Could not load ${filePath}: ${err.message}`);
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function loadTenantsRegistry() {
  const tenants = loadJson(TENANTS_REGISTRY, []);
  return Array.isArray(tenants) ? tenants : [];
}

function saveTenantsRegistry(tenants) {
  saveJson(TENANTS_REGISTRY, tenants);
}

function findTenantById(tenantId) {
  return loadTenantsRegistry().find((t) => t.id === tenantId) || null;
}

// ── Referral helpers ──────────────────────────────────────────────────────────
function loadReferralAccounts() {
  const data = loadJson(REFERRAL_ACCOUNTS_FILE, {});
  return typeof data === 'object' && !Array.isArray(data) ? data : {};
}
function saveReferralAccounts(accounts) { saveJson(REFERRAL_ACCOUNTS_FILE, accounts); }

function loadReferralEarnings() {
  const arr = loadJson(REFERRAL_EARNINGS_FILE, []);
  return Array.isArray(arr) ? arr : [];
}
function saveReferralEarnings(earnings) { saveJson(REFERRAL_EARNINGS_FILE, earnings); }

/** Ensure a referral account record exists for a code */
function ensureReferralAccount(code, percent = 0.1) {
  const accounts = loadReferralAccounts();
  if (!accounts[code]) {
    accounts[code] = {
      code,
      percent,
      payoutMode: 'offchain_fiat',
      wallet: null,
      fiatMethod: { type: 'bank', iban: '', holder: '' },
      tenants: [],
      totals: { earnedFiat: 0, paidFiat: 0 }
    };
  }
  return accounts;
}

/** Fire-and-forget: call ThronosChain core /api/referrals/register */
async function coreReferralRegister(tenantId, refCode, percent) {
  const nodeUrl = (process.env.THRONOS_NODE_URL || '').replace(/\/$/, '');
  if (!nodeUrl || !refCode) return;
  try {
    await axios.post(
      `${nodeUrl}/api/referrals/register`,
      { tenantId, refCode, percent },
      { headers: { 'X-API-Key': process.env.THRONOS_COMMERCE_API_KEY || '' }, timeout: 5000 }
    );
    console.log(`[Referral] Registered refCode=${refCode} tenant=${tenantId} with core`);
  } catch (err) {
    console.error(`[Referral] core register failed (will retry on next update): ${err.message}`);
  }
}

/** Fire-and-forget: call ThronosChain core /api/referrals/earn */
async function coreReferralEarn(payload) {
  const nodeUrl = (process.env.THRONOS_NODE_URL || '').replace(/\/$/, '');
  if (!nodeUrl) return;
  try {
    await axios.post(
      `${nodeUrl}/api/referrals/earn`,
      payload,
      { headers: { 'X-API-Key': process.env.THRONOS_COMMERCE_API_KEY || '' }, timeout: 5000 }
    );
    console.log(`[Referral] Earned event sent to core: ${JSON.stringify(payload)}`);
  } catch (err) {
    console.error(`[Referral] core earn failed: ${err.message}`);
  }
}

function tenantPaths(tenantId) {
  const base = path.join(TENANTS_DIR, tenantId);
  ensureDir(base);
  const media = path.join(base, 'media');
  ensureDir(media);
  return {
    base,
    config: path.join(base, 'config.json'),
    products: path.join(base, 'products.json'),
    categories: path.join(base, 'categories.json'),
    orders: path.join(base, 'orders.json'),
    reviews: path.join(base, 'reviews.json'),
    stockLog: path.join(base, 'stock_log.json'),
    analytics: path.join(base, 'analytics.json'),
    favicon: path.join(base, 'favicon.png'),
    media
  };
}

function loadTenantOrders(req) {
  try {
    const raw = fs.readFileSync(req.tenantPaths.orders, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[Thronos Commerce] Malformed orders.json for tenant ${req.tenant.id}: ${err.message} – falling back to empty array.`);
    }
    return [];
  }
}

function appendTenantOrder(req, order) {
  ensureDir(req.tenantPaths.base);
  const orders = loadTenantOrders(req);
  orders.push(order);
  saveJson(req.tenantPaths.orders, orders);
}

function getTenantByHost(hostname) {
  const tenants = loadTenantsRegistry();
  const host = (hostname || '').toLowerCase();
  let tenant = tenants.find(
    (t) =>
      t.domain &&
      t.domain.toLowerCase() === host
  );
  if (!tenant && tenants.length > 0) {
    // dev fallback to demo or first active tenant
    tenant = tenants.find((t) => t.id === 'demo') || tenants.find((t) => t.active) || tenants[0];
  }
  return tenant;
}

// Tenant-scoped loaders
function loadTenantConfig(req) {
  const fallback = {
    storeName: 'Thronos Demo Store',
    primaryColor: '#222222',
    accentColor: '#00ff88',
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    heroText: 'Καλωσήρθατε στο Thronos Commerce!',
    web3Domain: '',
    logoPath: '/logo.svg',
    shippingOptions: [],
    paymentOptions: [],
    theme: {
      menuBg: '#111111',
      menuText: '#ffffff',
      menuActiveBg: '#f06292',
      menuActiveText: '#ffffff',
      buttonRadius: '4px'
    }
  };
  return loadJson(req.tenantPaths.config, fallback);
}

function loadTenantProducts(req) {
  return loadJson(req.tenantPaths.products, []);
}

function loadTenantCategories(req) {
  return loadJson(req.tenantPaths.categories, []);
}

function saveTenantCategories(req, categories) {
  saveJson(req.tenantPaths.categories, categories);
}

function getSupportPermissions(supportTier) {
  const map = {
    SELF_SERVICE: {
      canEditSettings: true,
      canEditProducts: true,
      canUploadMedia: true,
      canEditCategories: true,
      canDigitalContent: false
    },
    MANAGEMENT_START: {
      canEditSettings: true,
      canEditProducts: true,
      canUploadMedia: true,
      canEditCategories: true,
      canDigitalContent: false
    },
    FULL_OPS_START: {
      canEditSettings: false,
      canEditProducts: false,
      canUploadMedia: false,
      canEditCategories: false,
      canDigitalContent: false
    },
    DIGITAL_STARTER: {
      canEditSettings: true,
      canEditProducts: true,
      canUploadMedia: true,
      canEditCategories: true,
      canDigitalContent: true
    },
    DIGITAL_PRO: {
      canEditSettings: true,
      canEditProducts: true,
      canUploadMedia: true,
      canEditCategories: true,
      canDigitalContent: true
    }
  };
  return map[supportTier] || map.SELF_SERVICE;
}

function calculateTotals(config, product, shippingMethodId, paymentMethodId) {
  const shippingMethod = (config.shippingOptions || []).find((s) => s.id === shippingMethodId);
  const paymentMethod = (config.paymentOptions || []).find((p) => p.id === paymentMethodId);

  if (!shippingMethod) {
    throw new Error('Invalid shipping method');
  }
  if (!paymentMethod) {
    throw new Error('Invalid payment method');
  }
  if (
    Array.isArray(shippingMethod.allowedPaymentMethods) &&
    !shippingMethod.allowedPaymentMethods.includes(paymentMethod.id)
  ) {
    throw new Error('Ο συγκεκριμένος τρόπος πληρωμής δεν είναι διαθέσιμος για αυτή τη μέθοδο αποστολής.');
  }

  const subtotal = Number(product.price) || 0;
  const shippingCost = Number(shippingMethod.base) || 0;
  const codFee =
    paymentMethod.id === 'COD' ? Number(shippingMethod.codFee || 0) : 0;
  const gatewaySurchargePercent = Number(paymentMethod.gatewaySurchargePercent) || 0;
  const gatewayFee = subtotal * gatewaySurchargePercent;

  const total = subtotal + shippingCost + codFee + gatewayFee;

  return {
    subtotal,
    shippingCost,
    codFee,
    gatewayFee,
    total,
    shippingMethod,
    paymentMethod
  };
}

// Multi-item cart totals
function calculateCartTotals(config, cartItems, shippingMethodId, paymentMethodId) {
  const shippingMethod = (config.shippingOptions || []).find((s) => s.id === shippingMethodId);
  const paymentMethod  = (config.paymentOptions  || []).find((p) => p.id === paymentMethodId);
  if (!shippingMethod) throw new Error('Invalid shipping method');
  if (!paymentMethod)  throw new Error('Invalid payment method');
  if (
    Array.isArray(shippingMethod.allowedPaymentMethods) &&
    !shippingMethod.allowedPaymentMethods.includes(paymentMethod.id)
  ) throw new Error('Ο συγκεκριμένος τρόπος πληρωμής δεν είναι διαθέσιμος για αυτή τη μέθοδο αποστολής.');

  const subtotal     = cartItems.reduce((s, i) => s + (Number(i.price) || 0) * (i.qty || 1), 0);
  const shippingCost = Number(shippingMethod.base) || 0;
  const codFee       = paymentMethod.id === 'COD' ? Number(shippingMethod.codFee || 0) : 0;
  const gatewayFee   = subtotal * (Number(paymentMethod.gatewaySurchargePercent) || 0);
  const total        = subtotal + shippingCost + codFee + gatewayFee;
  return { subtotal, shippingCost, codFee, gatewayFee, total, shippingMethod, paymentMethod };
}

async function recordOrderOnChain(order, tenant) {
  const payload = {
    orderId: order.id,
    total: order.total,
    timestamp: order.createdAt,
    customerEmail: order.email,
    wallet: order.wallet || null,
    tenantId: tenant ? tenant.id : null
  };

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');

  const nodeUrl = (process.env.THRONOS_NODE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.THRONOS_COMMERCE_API_KEY || null;

  if (!nodeUrl) {
    console.log('THRONOS_NODE_URL not set; skipping on-chain call. Hash:', hash);
    return hash;
  }

  try {
    const response = await axios.post(
      `${nodeUrl}/api/commerce/attest`,
      {
        ...payload,
        hash,
        apiKey
      },
      { timeout: 4000 }
    );
    console.log('Thronos node response:', response.data);
  } catch (err) {
    console.error('Failed to send order to Thronos node:', err.message);
  }

  return hash;
}

async function verifyAdminPassword(tenant, plainPassword) {
  if (!tenant.adminPasswordHash) {
    return false;
  }
  const ok = await bcrypt.compare(plainPassword || '', tenant.adminPasswordHash);
  return ok;
}

// Root operator auth
const ROOT_ADMIN_PASSWORD = process.env.THRONOS_ROOT_ADMIN_PASSWORD || '';

function verifyRootPassword(plain) {
  if (!ROOT_ADMIN_PASSWORD) return false;
  return (plain || '') === ROOT_ADMIN_PASSWORD;
}

// Seed a new tenant's files from a template tenant (default: 'demo')
function seedTenantFilesFromTemplate(tenantId, templateId = 'demo') {
  const newPaths = tenantPaths(tenantId);
  const tplPaths = tenantPaths(templateId);

  if (!fs.existsSync(newPaths.config)) {
    const tplConfig = loadJson(tplPaths.config, {
      storeName: tenantId,
      primaryColor: '#222222',
      accentColor: '#00ff88',
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      heroText: 'Καλωσήρθατε στο κατάστημά μας!',
      web3Domain: '',
      logoPath: '/logo.svg',
      shippingOptions: [],
      paymentOptions: [],
      theme: { menuBg: '#111111', menuText: '#ffffff', menuActiveBg: '#f06292', menuActiveText: '#ffffff', buttonRadius: '4px' }
    });
    tplConfig.storeName = tenantId;
    saveJson(newPaths.config, tplConfig);
  }

  if (!fs.existsSync(newPaths.products)) {
    saveJson(newPaths.products, loadJson(tplPaths.products, []));
  }

  if (!fs.existsSync(newPaths.categories)) {
    saveJson(newPaths.categories, loadJson(tplPaths.categories, []));
  }
}

// ── Mailer ────────────────────────────────────────────────────────────────────

function buildTransport() {
  if (!nodemailer) return null;
  const host = process.env.THRC_SMTP_HOST;
  const port = Number(process.env.THRC_SMTP_PORT || '587');
  const user = process.env.THRC_SMTP_USER;
  const pass = process.env.THRC_SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

async function sendOrderEmail({ tenant, config, order }) {
  const transport = buildTransport();
  if (!transport) {
    console.log('[Thronos Commerce] Mailer not configured – skipping email.');
    return;
  }

  const recipients = (config.notificationEmails || []).join(',');
  if (!recipients) {
    console.log(`[Thronos Commerce] No notificationEmails set for tenant ${tenant.id} – skipping email.`);
    return;
  }

  const fromName = config.notificationFromName || config.storeName || 'Thronos Commerce Store';
  const from = `"${fromName}" <${process.env.THRC_SMTP_FROM || process.env.THRC_SMTP_USER}>`;
  const subject = `[${tenant.id}] Νέα παραγγελία #${order.id} – ${order.productName}`;

  const lines = [
    `Κατάστημα: ${config.storeName} (${tenant.domain || tenant.id})`,
    `Κωδικός παραγγελίας: ${order.id}`,
    `Προϊόν: ${order.productName}`,
    `Σύνολο: ${Number(order.total).toFixed(2)} €`,
    `Τρόπος αποστολής: ${order.shippingMethodLabel}`,
    `Τρόπος πληρωμής: ${order.paymentMethodLabel}`,
    '',
    `Πελάτης: ${order.customerName}`,
    `Email: ${order.email}`,
    `Σημειώσεις: ${order.notes || '–'}`,
    '',
    `Κατάσταση πληρωμής: ${order.paymentStatus}`,
    '',
    `Blockchain proof hash: ${order.proofHash || 'pending'}`
  ];

  const cc = config.notificationCcCustomer ? order.email : undefined;
  await transport.sendMail({
    from,
    to: recipients,
    ...(cc ? { cc } : {}),
    subject,
    text: lines.join('\n')
  });
  console.log(`[Thronos Commerce] Order email sent for ${order.id} → ${recipients}`);
}

// ── Generic webhook (mobile / Viber bridge) ───────────────────────────────────

async function sendOrderWebhook({ tenant, config, order }) {
  const url = (config.notificationWebhookUrl || '').trim();
  if (!url) return;

  const payload = {
    tenantId: tenant.id,
    domain: tenant.domain || '',
    orderId: order.id,
    total: order.total,
    status: order.paymentStatus,
    customerName: order.customerName,
    customerEmail: order.email,
    createdAt: order.createdAt
  };

  const secret = (config.notificationWebhookSecret || '').trim();
  const headers = {};
  if (secret) {
    headers['X-Thronos-Signature'] = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  await axios.post(url, payload, { timeout: 3000, headers });
  console.log(`[Thronos Commerce] Webhook sent for order ${order.id} → ${url}`);
}

// ── Enhanced mailer (THRC_MAIL_* env vars) ───────────────────────────────────

function getMailerTransport() {
  if (!nodemailer) return null;
  const host = process.env.THRC_MAIL_SMTP_HOST;
  const port = Number(process.env.THRC_MAIL_SMTP_PORT || '587');
  const user = process.env.THRC_MAIL_SMTP_USER;
  const pass = process.env.THRC_MAIL_SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

async function sendOrderEmails(order, config) {
  const transport = getMailerTransport();
  if (!transport) {
    console.log('[Thronos Commerce] THRC_MAIL transport not configured – skipping sendOrderEmails.');
    return;
  }

  const fromAddress = (process.env.THRC_MAIL_FROM || process.env.THRC_MAIL_SMTP_USER || '').trim();
  const fromName = config.storeName || 'Thronos Commerce';
  const from = `"${fromName}" <${fromAddress}>`;

  const bodyLines = [
    `Κωδικός παραγγελίας: ${order.id}`,
    `Προϊόν: ${order.productName}`,
    `Σύνολο: ${Number(order.total).toFixed(2)} €`,
    `Αποστολή: ${order.shippingMethodLabel}`,
    `Πληρωμή: ${order.paymentMethodLabel}`,
    `Πελάτης: ${order.customerName}`,
    `Email πελάτη: ${order.email}`,
    `Σημειώσεις: ${order.notes || '–'}`,
    `Blockchain proof: ${order.proofHash || 'pending'}`
  ].join('\n');

  const sends = [];
  const notificationEmail = (process.env.THRC_NOTIFICATION_EMAIL || '').trim();

  if (notificationEmail) {
    sends.push(
      transport.sendMail({
        from,
        to: notificationEmail,
        subject: `[${order.tenantId}] Νέα παραγγελία #${order.id} – ${order.productName}`,
        text: `Νέα παραγγελία στο κατάστημα ${config.storeName}!\n\n${bodyLines}`
      })
    );
  }

  if (order.email) {
    sends.push(
      transport.sendMail({
        from,
        to: order.email,
        subject: `Επιβεβαίωση παραγγελίας #${order.id} – ${config.storeName}`,
        text: `Γεια σας ${order.customerName},\n\nΛάβαμε την παραγγελία σας!\n\n${bodyLines}\n\nΕυχαριστούμε!\n${config.storeName}`
      })
    );
  }

  if (sends.length > 0) {
    await Promise.all(sends);
    console.log(
      `[Thronos Commerce] sendOrderEmails: merchant=${notificationEmail || 'none'}, customer=${order.email}`
    );
  }
}

async function attestMailToThronos(order, meta) {
  const nodeUrl = (process.env.THRONOS_NODE_URL || '').replace(/\/$/, '');
  if (!nodeUrl) return null;

  const from      = meta.from || '';
  const toRaw     = meta.to || '';
  const to        = Array.isArray(toRaw) ? toRaw : [toRaw].filter(Boolean);
  const subject   = meta.subject || '';
  const timestamp = meta.timestamp || order.createdAt || new Date().toISOString();
  const tenantId  = order.tenantId || (order.tenant && order.tenant.id) || '';
  const canonical = `${from}|${to.join(',')}|${subject}|${order.id}|${order.total}|${timestamp}`;
  const hash      = crypto.createHash('sha256').update(canonical).digest('hex');

  try {
    const response = await axios.post(
      `${nodeUrl}/api/mail/attest`,
      {
        from,
        to,
        subject,
        timestamp,
        hash,
        tenantId,
        orderId:  order.id,
        apiKey:   process.env.THRONOS_COMMERCE_API_KEY || null,
        meta:     meta.extra || {}
      },
      { timeout: 4000 }
    );
    console.log('[Thronos Commerce] attestMailToThronos response:', response.data);
  } catch (err) {
    console.error('[Thronos Commerce] attestMailToThronos failed:', err.message);
  }

  return hash;
}

// ─────────────────────────────────────────────────────────────────────────────

// Multer storage for per-tenant media
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const mediaDir =
      (req.tenantPaths && req.tenantPaths.media) ||
      path.join(TENANTS_DIR, '_uploads');
    ensureDir(mediaDir);
    cb(null, mediaDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path
      .basename(file.originalname || 'upload', ext)
      .replace(/[^a-z0-9_-]/gi, '-')
      .toLowerCase();
    cb(null, `${Date.now()}-${base}${ext || '.jpg'}`);
  }
});

const upload = multer({ storage });

// Separate multer for favicon (memory storage, 512 KB limit)
const favUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpeg|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(file.mimetype);
    cb(null, ok);
  }
});

// View engine & middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/tenants', express.static(TENANTS_DIR));
// Raw body for Stripe webhook signature verification (must be before urlencoded)
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// i18n middleware – sets req.lang, res.locals.lang, res.locals.t
app.use((req, res, next) => {
  req.lang = getLangFromRequest(req);
  res.locals.lang = req.lang;
  res.locals.t = (key) => translate(req.lang, key);
  next();
});

// Tenant resolution middleware (skips root operator panel)
app.use((req, res, next) => {
  if (req.path.startsWith('/root')) return next();
  const hostHeader = (req.headers.host || '').split(':')[0];
  const tenant = getTenantByHost(hostHeader);
  if (!tenant) {
    return res
      .status(503)
      .send('No tenant configured for this host. Check tenants.json.');
  }
  req.tenant = tenant;
  req.tenantPaths = tenantPaths(tenant.id);
  next();
});

function buildAdminViewModel(req, extra) {
  const config = loadTenantConfig(req);
  const products = loadTenantProducts(req);
  const categories = loadTenantCategories(req);
  const permissions = getSupportPermissions(req.tenant.supportTier);
  const orders = loadTenantOrders(req);
  const stockLog = loadJson(req.tenantPaths.stockLog, []);
  const analytics = loadJson(req.tenantPaths.analytics, { pageViews: {}, cities: {} });

  // Build per-product order counts for chart
  const orderCounts = {};
  orders.forEach((o) => {
    orderCounts[o.productId] = (orderCounts[o.productId] || 0) + 1;
  });
  // Build top cities
  const cityCounts = {};
  orders.forEach((o) => {
    const city = (o.city || '').trim();
    if (city) cityCounts[city] = (cityCounts[city] || 0) + 1;
  });

  return {
    tenant: req.tenant,
    permissions,
    config,
    categories,
    products,
    productsJson: JSON.stringify(products, null, 2),
    stockLog: stockLog.slice(-100).reverse(),
    analytics,
    orderCounts,
    cityCounts,
    hasFavicon: fs.existsSync(req.tenantPaths.favicon),
    message: null,
    error: null,
    ...(extra || {})
  };
}

// Routes

// Per-tenant favicon
app.get('/favicon.ico', (req, res) => {
  const faviconPath = req.tenantPaths && req.tenantPaths.favicon;
  if (faviconPath && fs.existsSync(faviconPath)) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(faviconPath);
  }
  res.status(204).end();
});

// Storefront home
app.get('/', (req, res) => {
  const config = loadTenantConfig(req);
  const categories = loadTenantCategories(req);
  const allProducts = loadTenantProducts(req);

  const catSlug = req.query.category;
  let products = allProducts;

  if (catSlug) {
    const cat = categories.find((c) => c.slug === catSlug);
    if (cat) {
      products = allProducts.filter((p) => p.categoryId === cat.id);
    } else {
      products = [];
    }
  }

  res.render('index', {
    config,
    categories,
    products,
    activeCategory: catSlug || null,
    tenant: req.tenant
  });
});

// Product detail
app.get('/product/:id', (req, res) => {
  const config = loadTenantConfig(req);
  const products = loadTenantProducts(req);
  const product = products.find((p) => p.id === req.params.id);

  if (!product) {
    return res.status(404).send('Product not found');
  }

  // Track page views (fire-and-forget)
  try {
    const analytics = loadJson(req.tenantPaths.analytics, { pageViews: {}, cities: {} });
    analytics.pageViews[product.id] = (analytics.pageViews[product.id] || 0) + 1;
    saveJson(req.tenantPaths.analytics, analytics);
  } catch (_) { /* non-critical */ }

  res.render('product', {
    config,
    product,
    tenant: req.tenant
  });
});

// Checkout page
app.get('/checkout', (req, res) => {
  const config = loadTenantConfig(req);
  res.render('checkout', { config, tenant: req.tenant });
});

// Checkout submit (multi-item cart)
app.post('/checkout', async (req, res) => {
  const config = loadTenantConfig(req);
  const products = loadTenantProducts(req);
  const {
    name, email, wallet, notes, shippingMethodId, paymentMethodId,
    city, phone, address, doorbell, tk, cartJson
  } = req.body;

  // ── Parse cart items ──────────────────────────────────────────────
  let cartItems = [];
  try { cartItems = JSON.parse(cartJson || '[]'); } catch (_) {}
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).send('Cart is empty');
  }

  // Validate & enrich items from server-side product catalog
  // Resolves variant price & label server-side (never trust client price)
  const allProductsCatalog = loadTenantProducts(req);
  const enrichedItems = [];
  for (const ci of cartItems) {
    const found = allProductsCatalog.find((p) => p.id === ci.id);
    if (found) {
      let serverPrice = Number(found.price) || 0;
      let variantLabel = '';
      let variantId = (ci.variantId || '').trim();
      // Resolve variant price
      if (variantId && Array.isArray(found.variants)) {
        const variant = found.variants.find((v) => v.id === variantId);
        if (variant) {
          serverPrice  = Number(variant.price) || serverPrice;
          variantLabel = variant.label || '';
        } else {
          variantId = ''; // invalid variant → clear
        }
      }
      enrichedItems.push({
        id:           found.id,
        name:         found.name,
        variantId:    variantId || undefined,
        variantLabel: variantLabel || undefined,
        price:        serverPrice,
        qty:          Math.max(1, parseInt(ci.qty, 10) || 1)
      });
    }
  }
  if (!enrichedItems.length) return res.status(400).send('No valid products in cart');

  let totals;
  try {
    totals = calculateCartTotals(config, enrichedItems, shippingMethodId, paymentMethodId);
  } catch (err) {
    return res.status(400).send(err.message);
  }

  const orderId = Date.now().toString();
  const order = {
    id: orderId,
    tenantId: req.tenant.id,
    // Keep single-product fields for backward compat (first item)
    productId:   enrichedItems[0].id,
    productName: enrichedItems.map((i) =>
      i.variantLabel ? `${i.name} – ${i.variantLabel} ×${i.qty}` : `${i.name} ×${i.qty}`
    ).join(', '),
    price:       enrichedItems[0].price,
    // Multi-item
    items: enrichedItems,
    customerName: name,
    email,
    phone:    (phone    || '').trim(),
    address:  (address  || '').trim(),
    doorbell: (doorbell || '').trim(),
    tk:       (tk       || '').trim(),
    city:     (city     || '').trim(),
    wallet:   wallet || '',
    notes:    notes  || '',
    shippingMethodId,
    paymentMethodId,
    shippingMethodLabel: totals.shippingMethod.label,
    paymentMethodLabel:  totals.paymentMethod.label,
    subtotal:    totals.subtotal,
    shippingCost: totals.shippingCost,
    codFee:      totals.codFee,
    gatewayFee:  totals.gatewayFee,
    total:       totals.total,
    paymentStatus: paymentMethodId === 'CARD' ? 'PENDING_STRIPE' : 'PENDING_COD',
    createdAt: new Date().toISOString()
  };

  console.log('[Thronos Commerce] New cart order:', JSON.stringify(order));

  const proofHash = await recordOrderOnChain(order, req.tenant);
  order.proofHash = proofHash;
  appendTenantOrder(req, order);

  // ── Stock deduction (per item) ────────────────────────────────────
  const allProductsMut = loadTenantProducts(req);
  const stockLog = loadJson(req.tenantPaths.stockLog, []);
  enrichedItems.forEach((ci) => {
    const pIdx = allProductsMut.findIndex((p) => p.id === ci.id);
    if (pIdx < 0) return;
    const prod = allProductsMut[pIdx];
    if (ci.variantId && Array.isArray(prod.variants)) {
      const vIdx = prod.variants.findIndex((v) => v.id === ci.variantId);
      if (vIdx >= 0) {
        prod.variants[vIdx].stock = Math.max(0, (prod.variants[vIdx].stock || 0) - ci.qty);
        stockLog.push({
          id:           Date.now().toString(36) + '_' + ci.id,
          productId:    ci.id,
          productName:  ci.name,
          variantId:    ci.variantId,
          variantLabel: ci.variantLabel,
          delta:        -ci.qty,
          reason:       'order',
          orderId,
          createdAt:    order.createdAt
        });
      }
    } else if ((prod.stock || 0) > 0) {
      prod.stock = Math.max(0, prod.stock - ci.qty);
      stockLog.push({
        id:          Date.now().toString(36) + '_' + ci.id,
        productId:   ci.id,
        productName: ci.name,
        delta:       -ci.qty,
        reason:      'order',
        orderId,
        createdAt:   order.createdAt
      });
    }
  });
  saveJson(req.tenantPaths.products, allProductsMut);
  saveJson(req.tenantPaths.stockLog, stockLog);

  // ── Analytics: track city ──────────────────────────────────────
  if (order.city) {
    try {
      const analytics = loadJson(req.tenantPaths.analytics, { pageViews: {}, cities: {} });
      analytics.cities[order.city] = (analytics.cities[order.city] || 0) + 1;
      saveJson(req.tenantPaths.analytics, analytics);
    } catch (_) { /* non-critical */ }
  }

  try {
    await sendOrderEmail({ tenant: req.tenant, config, order });
  } catch (err) {
    console.error('[Thronos Commerce] sendOrderEmail failed:', err.message);
  }

  try {
    await sendOrderWebhook({ tenant: req.tenant, config, order });
  } catch (err) {
    console.error('[Thronos Commerce] sendOrderWebhook failed:', err.message);
  }

  const mailFrom = (process.env.THRC_MAIL_FROM || process.env.THRC_MAIL_SMTP_USER || '').trim();
  const mailSubject = `Νέα παραγγελία #${order.id} – ${config.storeName}`;
  sendOrderEmails(order, config).catch((err) =>
    console.error('[Thronos Commerce] sendOrderEmails failed:', err.message)
  );
  attestMailToThronos(order, { from: mailFrom, to: [order.email], subject: mailSubject }).catch(
    (err) => console.error('[Thronos Commerce] attestMailToThronos failed:', err.message)
  );

  // Compute content URL if any purchased product has digital content
  const allProductsForContent = loadTenantProducts(req);
  const hasDigital = enrichedItems.some((ci) => {
    const p = allProductsForContent.find((pp) => pp.id === ci.id);
    return p && p.hasDigitalContent;
  });

  res.render('thanks', {
    config,
    order,
    proofHash,
    tenant: req.tenant,
    clearCart: true,
    contentUrl: hasDigital ? `/content/${order.id}` : null
  });
});

// ── Reviews API ──────────────────────────────────────────────────────────────

app.get('/api/products/:productId/reviews', (req, res) => {
  const reviews = loadJson(req.tenantPaths.reviews, []);
  const filtered = reviews.filter((r) => r.productId === req.params.productId);
  res.json(filtered);
});

// Verified-purchase check
app.get('/api/products/:productId/can-review', (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ canReview: false });
  const orders = loadTenantOrders(req);
  const hasBought = orders.some(
    (o) =>
      (o.email || '').toLowerCase() === email &&
      (o.productId === req.params.productId ||
        (Array.isArray(o.items) && o.items.some((i) => i.id === req.params.productId)))
  );
  res.json({ canReview: hasBought });
});

app.post('/api/products/:productId/reviews', (req, res) => {
  const { name, rating, comment, email } = req.body;
  const ratingNum = parseInt(rating, 10);
  if (!name || !name.trim()) return res.status(400).json({ error: 'Το όνομα είναι υποχρεωτικό.' });
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Το σχόλιο είναι υποχρεωτικό.' });
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) return res.status(400).json({ error: 'Η βαθμολογία πρέπει να είναι 1–5.' });

  // Server-side verified-purchase check
  const reviewerEmail = (email || '').trim().toLowerCase();
  const orders = loadTenantOrders(req);
  const verified = reviewerEmail
    ? orders.some(
        (o) =>
          (o.email || '').toLowerCase() === reviewerEmail &&
          (o.productId === req.params.productId ||
            (Array.isArray(o.items) && o.items.some((i) => i.id === req.params.productId)))
      )
    : false;

  if (!verified) {
    return res.status(403).json({ error: 'Μόνο επαληθευμένοι αγοραστές μπορούν να γράψουν αξιολόγηση.' });
  }

  const review = {
    id: Date.now().toString(36),
    productId: req.params.productId,
    name: name.trim(),
    rating: ratingNum,
    comment: comment.trim(),
    verified: true,
    createdAt: new Date().toISOString()
  };
  const reviews = loadJson(req.tenantPaths.reviews, []);
  reviews.push(review);
  saveJson(req.tenantPaths.reviews, reviews);
  res.json({ ok: true, review });
});

// Admin panel
app.get('/admin', (req, res) => {
  res.render('admin', buildAdminViewModel(req));
});

// Admin orders view
app.get('/admin/orders', (req, res) => {
  const config = loadTenantConfig(req);
  const allOrders = loadTenantOrders(req);
  const orders = allOrders.slice(-100).reverse();
  res.render('admin-orders', {
    tenant: req.tenant,
    config,
    orders,
    permissions: getSupportPermissions(req.tenant.supportTier)
  });
});

app.post('/admin/settings', async (req, res) => {
  const {
    password,
    storeName,
    primaryColor,
    accentColor,
    fontFamily,
    heroText,
    web3Domain,
    logoPath,
    themeMenuBg,
    themeMenuText,
    themeMenuActiveBg,
    themeMenuActiveText,
    themeButtonRadius
  } = req.body;

  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditSettings) {
    return res
      .status(403)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή ρυθμίσεων.'
        })
      );
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' })
      );
  }

  const config = loadTenantConfig(req);
  config.storeName = storeName || config.storeName;
  config.primaryColor = primaryColor || config.primaryColor;
  config.accentColor = accentColor || config.accentColor;
  config.fontFamily = fontFamily || config.fontFamily;
  config.heroText = heroText || config.heroText;
  config.web3Domain = web3Domain || config.web3Domain;
  config.logoPath = logoPath || config.logoPath;
  config.theme = config.theme || {};
  config.theme.menuBg = themeMenuBg || config.theme.menuBg || '#111111';
  config.theme.menuText = themeMenuText || config.theme.menuText || '#ffffff';
  config.theme.menuActiveBg =
    themeMenuActiveBg || config.theme.menuActiveBg || '#f06292';
  config.theme.menuActiveText =
    themeMenuActiveText || config.theme.menuActiveText || '#ffffff';
  config.theme.buttonRadius =
    themeButtonRadius || config.theme.buttonRadius || '4px';

  // Notification settings
  config.notificationEmails = (req.body.notificationEmails || '')
    .split('\n').map((e) => e.trim()).filter((e) => e.length > 0);
  config.notificationCcCustomer = req.body.notificationCcCustomer === 'on';
  config.notificationFromName   = (req.body.notificationFromName   || '').trim();
  config.notificationWebhookUrl    = (req.body.notificationWebhookUrl    || '').trim();
  config.notificationWebhookSecret = (req.body.notificationWebhookSecret || '').trim();

  saveJson(req.tenantPaths.config, config);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Οι ρυθμίσεις αποθηκεύτηκαν.' })
  );
});

// Shipping & Payment options editor
app.post('/admin/shipping-payment', async (req, res) => {
  const { password } = req.body;

  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditSettings) {
    return res
      .status(403)
      .render('admin', buildAdminViewModel(req, {
        error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή μεταφορικών/πληρωμών.'
      }));
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' }));
  }

  const config = loadTenantConfig(req);

  // Update shippingOptions: only label, base, codFee — never touch id or allowedPaymentMethods
  (config.shippingOptions || []).forEach((opt, i) => {
    const label  = req.body[`ship_label_${i}`];
    const base   = req.body[`ship_base_${i}`];
    const codFee = req.body[`ship_codFee_${i}`];
    if (label  !== undefined) opt.label  = label;
    if (base   !== undefined) opt.base   = parseFloat(base)   || 0;
    if (codFee !== undefined) opt.codFee = parseFloat(codFee) || 0;
  });

  // Update paymentOptions: label only — gatewaySurchargePercent is root-admin-only
  (config.paymentOptions || []).forEach((opt, i) => {
    const label = req.body[`pay_label_${i}`];
    if (label !== undefined) opt.label = label;
  });

  saveJson(req.tenantPaths.config, config);

  res.render('admin', buildAdminViewModel(req, {
    message: 'Τα μεταφορικά και οι τρόποι πληρωμής αποθηκεύτηκαν.'
  }));
});

// Categories CRUD
app.post('/admin/categories/add', async (req, res) => {
  const { password, id, name, slug, parentId } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditCategories) {
    return res
      .status(403)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή κατηγοριών.'
        })
      );
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' })
      );
  }

  const categories = loadTenantCategories(req);
  if (categories.some((c) => c.id === id || c.slug === slug)) {
    return res
      .status(400)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Υπάρχει ήδη κατηγορία με αυτό το id ή slug.'
        })
      );
  }

  const newCat = { id, name, slug };
  if (parentId && parentId.trim()) newCat.parentId = parentId.trim();
  categories.push(newCat);
  saveTenantCategories(req, categories);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Η κατηγορία προστέθηκε.' })
  );
});

app.post('/admin/categories/update', async (req, res) => {
  const { password, categoryId, name, slug, parentId } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditCategories) {
    return res
      .status(403)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή κατηγοριών.'
        })
      );
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' })
      );
  }

  const categories = loadTenantCategories(req);
  const idx = categories.findIndex((c) => c.id === categoryId);
  if (idx === -1) {
    return res
      .status(404)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Η κατηγορία δεν βρέθηκε.' })
      );
  }

  if (
    slug &&
    categories.some((c) => c.id !== categoryId && c.slug === slug)
  ) {
    return res
      .status(400)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το slug χρησιμοποιείται ήδη από άλλη κατηγορία.'
        })
      );
  }

  categories[idx].name = name || categories[idx].name;
  categories[idx].slug = slug || categories[idx].slug;
  if (parentId !== undefined) {
    if (parentId && parentId.trim() && parentId.trim() !== categoryId) {
      categories[idx].parentId = parentId.trim();
    } else {
      delete categories[idx].parentId;
    }
  }
  saveTenantCategories(req, categories);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Η κατηγορία ενημερώθηκε.' })
  );
});

app.post('/admin/categories/delete', async (req, res) => {
  const { password, categoryId } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditCategories) {
    return res
      .status(403)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή κατηγοριών.'
        })
      );
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' })
      );
  }

  const categories = loadTenantCategories(req);
  const filtered = categories.filter((c) => c.id !== categoryId);
  saveTenantCategories(req, filtered);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Η κατηγορία διαγράφηκε.' })
  );
});

// Product JSON editor
app.post('/admin/products', async (req, res) => {
  const { password, productsJson } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditProducts) {
    return res
      .status(403)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή προϊόντων.',
          productsJson
        })
      );
  }

  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Λάθος κωδικός διαχειριστή.',
          productsJson
        })
      );
  }

  try {
    const parsed = JSON.parse(productsJson);
    if (!Array.isArray(parsed)) {
      throw new Error('Το JSON πρέπει να είναι array.');
    }
    const categories = loadTenantCategories(req);
    const config = loadTenantConfig(req);
    const storeName = (config.storeName || '').trim();
    parsed.forEach((p) => {
      if (!p.seoTitle) {
        const catObj = categories.find((c) => c.id === p.categoryId);
        const catName = catObj ? catObj.name : '';
        p.seoTitle = [p.name, catName, storeName].filter(Boolean).join(' | ');
      }
      if (!p.seoDescription) {
        const desc = (p.description || '').trim();
        p.seoDescription = desc.length > 160 ? desc.slice(0, 157) + '…' : desc || p.seoTitle;
      }
      if (!Array.isArray(p.gallery)) p.gallery = [];
    });
    saveJson(req.tenantPaths.products, parsed);
    res.render(
      'admin',
      buildAdminViewModel(req, {
        message: 'Τα προϊόντα αποθηκεύτηκαν.',
        productsJson: JSON.stringify(parsed, null, 2)
      })
    );
  } catch (err) {
    res.status(400).render(
      'admin',
      buildAdminViewModel(req, {
        error: 'Σφάλμα στο JSON προϊόντων: ' + err.message,
        productsJson
      })
    );
  }
});

// Manual stock adjustment
app.post('/admin/stock/adjust', async (req, res) => {
  const { password, productId, newStock, reason } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditProducts) {
    return res.status(403).render('admin', buildAdminViewModel(req, { error: 'Δεν επιτρέπεται.' }));
  }
  const ok = await verifyAdminPassword(req.tenant, password);
  if (!ok) {
    return res.status(401).render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός.' }));
  }
  const products = loadTenantProducts(req);
  const pIdx = products.findIndex((p) => p.id === productId);
  if (pIdx === -1) {
    return res.status(404).render('admin', buildAdminViewModel(req, { error: 'Προϊόν δεν βρέθηκε.' }));
  }
  const oldStock = products[pIdx].stock || 0;
  const qty = Math.max(0, parseInt(newStock, 10) || 0);
  const delta = qty - oldStock;
  products[pIdx].stock = qty;
  saveJson(req.tenantPaths.products, products);

  const stockLog = loadJson(req.tenantPaths.stockLog, []);
  stockLog.push({
    id:          Date.now().toString(36),
    productId,
    productName: products[pIdx].name,
    delta,
    reason:      reason || 'manual',
    orderId:     null,
    createdAt:   new Date().toISOString()
  });
  saveJson(req.tenantPaths.stockLog, stockLog);

  res.render('admin', buildAdminViewModel(req, { message: `Απόθεμα "${products[pIdx].name}" ενημερώθηκε σε ${qty}.` }));
});

// Image upload
app.post(
  '/admin/upload-image',
  upload.single('image'),
  async (req, res) => {
    const permissions = getSupportPermissions(req.tenant.supportTier);
    if (!permissions.canUploadMedia) {
      return res
        .status(403)
        .json({ ok: false, error: 'Upload not allowed for this support tier.' });
    }

    const password = req.body.password;
    const ok = await verifyAdminPassword(req.tenant, password);
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'Invalid admin password.' });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    }

    const url = `/tenants/${req.tenant.id}/media/${req.file.filename}`;
    return res.json({ ok: true, url });
  }
);

// Favicon upload
app.post(
  '/admin/favicon',
  favUpload.single('favicon'),
  async (req, res) => {
    const password = req.body.password;
    const ok = await verifyAdminPassword(req.tenant, password);
    if (!ok) {
      return res.redirect('/admin?error=Λάθος+κωδικός+διαχειριστή#tab-upload');
    }
    if (!req.file) {
      return res.redirect('/admin?error=Δεν+επιλέχθηκε+αρχείο#tab-upload');
    }
    fs.writeFileSync(req.tenantPaths.favicon, req.file.buffer);
    return res.redirect('/admin?message=Favicon+αποθηκεύτηκε#tab-upload');
  }
);

// Favicon delete
app.post('/admin/favicon/delete', async (req, res) => {
  const ok = await verifyAdminPassword(req.tenant, req.body.password);
  if (!ok) {
    return res.redirect('/admin?error=Λάθος+κωδικός+διαχειριστή#tab-upload');
  }
  if (fs.existsSync(req.tenantPaths.favicon)) {
    fs.unlinkSync(req.tenantPaths.favicon);
  }
  return res.redirect('/admin?message=Favicon+διαγράφηκε#tab-upload');
});

// ── Digital content: manual upload ───────────────────────────────────────────
const manualUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = (req.tenantPaths && req.tenantPaths.media) || path.join(TENANTS_DIR, '_uploads');
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.pdf';
      cb(null, `manual-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const ok = /^(application\/pdf|video\/(mp4|webm|ogg))$/.test(file.mimetype);
    cb(null, ok);
  }
});

app.post(
  '/admin/upload-manual',
  manualUpload.single('manual'),
  async (req, res) => {
    const permissions = getSupportPermissions(req.tenant.supportTier);
    if (!permissions.canDigitalContent) {
      return res.status(403).json({ ok: false, error: 'Digital content not available on this plan.' });
    }
    const ok = await verifyAdminPassword(req.tenant, req.body.password);
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid password.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file.' });
    const url = `/tenants/${req.tenant.id}/media/${req.file.filename}`;
    res.json({ ok: true, url, filename: req.file.filename });
  }
);

// ── Digital content: gated access page ───────────────────────────────────────
app.get('/content/:orderId', (req, res) => {
  const orders = loadTenantOrders(req);
  const order  = orders.find((o) => o.id === req.params.orderId);
  if (!order) return res.status(404).send('Η παραγγελία δεν βρέθηκε.');

  const config   = loadTenantConfig(req);
  const products = loadTenantProducts(req);

  // Collect all products in this order, merging per-variant content overrides
  let orderItems = [];
  if (Array.isArray(order.items) && order.items.length) {
    orderItems = order.items.map((i) => {
      const p = products.find((pr) => pr.id === i.id);
      if (!p) return null;
      // Merge variant-specific content fields if applicable
      if (i.variantId && Array.isArray(p.variants)) {
        const v = p.variants.find((vr) => vr.id === i.variantId);
        if (v) {
          return Object.assign({}, p, {
            videoUrl:           v.videoUrl           || p.videoUrl,
            contentDescription: v.contentDescription || p.contentDescription,
            _variantLabel:      v.label || ''
          });
        }
      }
      return p;
    }).filter(Boolean);
  } else if (order.productId) {
    const p = products.find((p) => p.id === order.productId);
    if (p) orderItems = [p];
  }

  const digitalItems = orderItems.filter((p) => p.hasDigitalContent);

  res.render('content', {
    config,
    order,
    digitalItems,
    tenant: req.tenant
  });
});

// ── Shared packages list ──────────────────────────────────────────────────────
function getLandingPackages() {
  return [
    {
      id: 'MANAGEMENT_START',
      title: 'Management Start',
      description: 'Ιδανικό για μικρά brands που θέλουν managed setup, χωρίς WordPress / WooCommerce.',
      features: [
        'Στήσιμο e-shop πάνω στο Thronos Commerce',
        'Βασικό theme & λογότυπο',
        'Admin panel για προϊόντα',
        'Σύνδεση με δικό σας domain & email'
      ]
    },
    {
      id: 'FULL_OPS_START',
      title: 'Full Ops Start',
      description: 'Για brands που θέλουν πλήρη διαχείριση λειτουργίας από την ομάδα Thronos.',
      features: [
        'Όλα του Management Start',
        'Πλήρης διαχείριση προϊόντων & περιεχομένου',
        'Παρακολούθηση παραγγελιών & επικοινωνίας',
        'Συμβουλευτικό growth roadmap'
      ]
    },
    {
      id: 'DIGITAL_STARTER',
      title: 'Digital Starter',
      description: 'Για creators & DIY brands που πουλούν digital προϊόντα: εγχειρίδια, βίντεο οδηγιών και ψηφιακό περιεχόμενο.',
      features: [
        'Όλα του Management Start',
        'Ανέβασμα PDF εγχειριδίων ανά προϊόν (έως 50 MB)',
        'Ενσωμάτωση βίντεο οδηγιών (YouTube / Vimeo / MP4)',
        'Gated content page για αγοραστές (μόνο με αριθμό παραγγελίας)',
        'Αυτόματος σύνδεσμος πρόσβασης στο email επιβεβαίωσης'
      ]
    },
    {
      id: 'DIGITAL_PRO',
      title: 'Digital Pro',
      description: 'Πλήρες πακέτο για digital-first επιχειρήσεις με πολλαπλά προϊόντα και ανεπτυγμένο περιεχόμενο.',
      features: [
        'Όλα του Digital Starter',
        'Πλήρης διαχείριση περιεχομένου από την ομάδα Thronos',
        'Unlimited εγχειρίδια & βίντεο ανά προϊόν',
        'Analytics πρόσβασης περιεχομένου',
        'Προτεραιότητα support'
      ]
    }
  ];
}

// Thronos Commerce marketing landing
app.get('/thronos-commerce', (req, res) => {
  res.render('landing', { packages: getLandingPackages(), message: null });
});

app.post('/thronos-commerce/offer', (req, res) => {
  const lead = {
    id: `lead_${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...req.body
  };
  console.log('New Thronos Commerce lead:', lead);

  const leadsFile = path.join(DATA_ROOT, 'leads.json');
  const leads = loadJson(leadsFile, []);
  leads.push(lead);
  saveJson(leadsFile, leads);

  const packages = getLandingPackages();

  res.render('landing', {
    packages,
    message: 'Ευχαριστούμε! Θα επικοινωνήσουμε μαζί σας σύντομα.'
  });
});

// ─── Root Admin: Tenants Management ──────────────────────────────────────────

const SUPPORT_TIERS = ['SELF_SERVICE', 'MANAGEMENT_START', 'FULL_OPS_START', 'DIGITAL_STARTER', 'DIGITAL_PRO'];

function buildRootViewModel(extra) {
  const tenants = loadTenantsRegistry();
  const tenantPaymentConfigs = {};
  tenants.forEach((t) => {
    try {
      const cfgPath = path.join(TENANTS_DIR, t.id, 'config.json');
      const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
      tenantPaymentConfigs[t.id] = cfg.paymentOptions || [];
    } catch (_) {
      tenantPaymentConfigs[t.id] = [];
    }
  });

  const refAccounts = loadReferralAccounts();
  const refEarnings = loadReferralEarnings();

  // Group pending earnings by refCode for the payouts UI
  const pendingByCode = {};
  refEarnings.filter((e) => e.status === 'pending').forEach((e) => {
    if (!pendingByCode[e.refCode]) pendingByCode[e.refCode] = { total: 0, rows: [] };
    pendingByCode[e.refCode].total = +(pendingByCode[e.refCode].total + e.amountFiat).toFixed(2);
    pendingByCode[e.refCode].rows.push(e);
  });

  return {
    tenants,
    tenantPaymentConfigs,
    refAccounts,
    refEarnings: refEarnings.slice(-200).reverse(),
    pendingByCode,
    message: null,
    error: null,
    ...(extra || {})
  };
}

app.get('/root/tenants', (req, res) => {
  res.render('root-tenants', buildRootViewModel());
});

app.post('/root/tenants/create', async (req, res) => {
  const { rootPassword, id, domain, supportTier, adminPasswordPlain, templateId, refCode, refPercent } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants',
      buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }

  const cleanId = (id || '').trim();
  if (!cleanId || !/^[a-z0-9_-]+$/i.test(cleanId)) {
    return res.status(400).render('root-tenants',
      buildRootViewModel({ error: 'Το tenant id είναι υποχρεωτικό και επιτρέπονται μόνο a-z, 0-9, _ και -.' }));
  }

  if (!adminPasswordPlain) {
    return res.status(400).render('root-tenants',
      buildRootViewModel({ error: 'Ο κωδικός admin είναι υποχρεωτικός.' }));
  }

  const tenants = loadTenantsRegistry();
  if (tenants.some((t) => t.id === cleanId)) {
    return res.status(400).render('root-tenants',
      buildRootViewModel({ error: `Υπάρχει ήδη tenant με id "${cleanId}".` }));
  }

  const adminPasswordHash = await bcrypt.hash(adminPasswordPlain, 10);
  const resolvedTier = SUPPORT_TIERS.includes(supportTier) ? supportTier : 'SELF_SERVICE';

  const cleanRefCode = (refCode || '').trim();
  const newTenant = {
    id: cleanId,
    domain: (domain || '').trim(),
    supportTier: resolvedTier,
    adminPasswordHash,
    createdAt: new Date().toISOString(),
    active: true,
    referral: cleanRefCode
      ? { code: cleanRefCode, percent: Math.min(0.5, parseFloat(refPercent) || 0.1) }
      : null
  };

  seedTenantFilesFromTemplate(cleanId, (templateId || '').trim() || 'demo');
  tenants.push(newTenant);
  saveTenantsRegistry(tenants);
  console.log(`[Root Admin] Created tenant: ${cleanId} (${resolvedTier})`);

  // Register referral with core if provided
  if (newTenant.referral && newTenant.referral.code) {
    const accounts = ensureReferralAccount(newTenant.referral.code, newTenant.referral.percent);
    if (!accounts[newTenant.referral.code].tenants.includes(cleanId)) {
      accounts[newTenant.referral.code].tenants.push(cleanId);
    }
    saveReferralAccounts(accounts);
    coreReferralRegister(cleanId, newTenant.referral.code, newTenant.referral.percent).catch(() => {});
  }

  res.render('root-tenants',
    buildRootViewModel({ message: `Ο tenant "${cleanId}" δημιουργήθηκε επιτυχώς.` }));
});

app.post('/root/tenants/update', (req, res) => {
  const { rootPassword, tenantId, domain, supportTier, active } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants',
      buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }

  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex((t) => t.id === tenantId);
  if (idx === -1) {
    return res.status(404).render('root-tenants',
      buildRootViewModel({ error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }

  if (domain !== undefined) tenants[idx].domain = (domain || '').trim();
  if (supportTier && SUPPORT_TIERS.includes(supportTier)) tenants[idx].supportTier = supportTier;
  tenants[idx].active = active === 'true' || active === '1' || active === 'on';

  saveTenantsRegistry(tenants);
  console.log(`[Root Admin] Updated tenant: ${tenantId}`);

  res.render('root-tenants',
    buildRootViewModel({ message: `Ο tenant "${tenantId}" ενημερώθηκε.` }));
});

app.post('/root/tenants/reset-admin-password', async (req, res) => {
  const { rootPassword, tenantId, newPassword } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants',
      buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }

  if (!newPassword) {
    return res.status(400).render('root-tenants',
      buildRootViewModel({ error: 'Ο νέος κωδικός είναι υποχρεωτικός.' }));
  }

  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex((t) => t.id === tenantId);
  if (idx === -1) {
    return res.status(404).render('root-tenants',
      buildRootViewModel({ error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }

  tenants[idx].adminPasswordHash = await bcrypt.hash(newPassword, 10);
  saveTenantsRegistry(tenants);
  console.log(`[Root Admin] Reset admin password for tenant: ${tenantId}`);

  res.render('root-tenants',
    buildRootViewModel({ message: `Ο κωδικός admin για τον tenant "${tenantId}" ενημερώθηκε.` }));
});

// Root: update gateway surcharge for a tenant's payment options
app.post('/root/tenants/payment-config', (req, res) => {
  const { rootPassword, tenantId } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants',
      buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }

  const tenants = loadTenantsRegistry();
  const tenant = tenants.find((t) => t.id === tenantId);
  if (!tenant) {
    return res.status(404).render('root-tenants',
      buildRootViewModel({ error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }

  const cfgPath = path.join(TENANTS_DIR, tenantId, 'config.json');
  const config = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  (config.paymentOptions || []).forEach((opt, i) => {
    const surcharge = req.body[`surcharge_${i}`];
    if (surcharge !== undefined) opt.gatewaySurchargePercent = parseFloat(surcharge) || 0;
  });
  saveJson(cfgPath, config);
  console.log(`[Root Admin] Updated payment surcharges for tenant: ${tenantId}`);

  res.render('root-tenants',
    buildRootViewModel({ message: `Τα surcharges για τον tenant "${tenantId}" αποθηκεύτηκαν.` }));
});

// ── Stripe webhook → referral earnings ───────────────────────────────────────
app.post('/stripe/webhook', async (req, res) => {
  const sig    = req.headers['stripe-signature'] || '';
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  let event;

  // Verify signature when secret is configured
  if (secret) {
    try {
      // Simple HMAC-SHA256 verification (Stripe-compatible payload structure)
      const payload   = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
      const parts     = sig.split(',').reduce((acc, p) => {
        const [k, v] = p.split('='); acc[k] = v; return acc;
      }, {});
      const ts        = parts.t;
      const expected  = crypto.createHmac('sha256', secret)
                              .update(`${ts}.${payload.toString()}`)
                              .digest('hex');
      if (expected !== parts.v1) {
        console.warn('[Stripe Webhook] Invalid signature');
        return res.status(400).json({ error: 'Invalid signature' });
      }
      event = JSON.parse(payload.toString());
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  } else {
    // No secret configured — accept raw JSON (dev/testing)
    try {
      event = typeof req.body === 'object' ? req.body : JSON.parse(req.body.toString());
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  const HANDLED = ['checkout.session.completed', 'invoice.payment_succeeded'];
  if (!HANDLED.includes(event.type)) return res.json({ received: true });

  const obj       = event.data && event.data.object;
  if (!obj) return res.json({ received: true });

  // Resolve tenantId from metadata
  const tenantId  = (obj.metadata && obj.metadata.tenantId) || '';
  const externalId = obj.id || '';
  const amountRaw = obj.amount_total || obj.amount_paid || 0;  // Stripe amount in cents
  const amountFiat = +(amountRaw / 100).toFixed(2);
  const currency  = (obj.currency || 'eur').toUpperCase();

  if (!tenantId || amountFiat <= 0) return res.json({ received: true });

  const tenants   = loadTenantsRegistry();
  const tenant    = tenants.find((t) => t.id === tenantId);
  if (!tenant || !tenant.referral || !tenant.referral.code) return res.json({ received: true });

  const refCode   = tenant.referral.code;
  const percent   = typeof tenant.referral.percent === 'number' ? tenant.referral.percent : 0.1;
  const commission = +(amountFiat * percent).toFixed(2);

  // Write earning row
  const earnings  = loadReferralEarnings();
  const earningId = `re_${Date.now().toString(36)}`;
  earnings.push({
    id:          earningId,
    tenantId,
    refCode,
    amountFiat:  commission,
    currency,
    source:      event.type === 'invoice.payment_succeeded' ? 'stripe_subscription' : 'stripe_checkout',
    externalId,
    status:      'pending',
    createdAt:   new Date().toISOString(),
    paidAt:      null,
    paidVia:     null,
    txId:        null
  });
  saveReferralEarnings(earnings);

  // Update account totals
  const accounts  = ensureReferralAccount(refCode, percent);
  accounts[refCode].totals.earnedFiat = +(accounts[refCode].totals.earnedFiat + commission).toFixed(2);
  if (!accounts[refCode].tenants.includes(tenantId)) accounts[refCode].tenants.push(tenantId);
  saveReferralAccounts(accounts);

  console.log(`[Referral] Earning recorded: refCode=${refCode} tenant=${tenantId} commission=${commission} ${currency}`);

  // Notify core (fire-and-forget)
  coreReferralEarn({
    tenantId,
    refCode,
    amountFiat: commission,
    currency,
    source:     event.type === 'invoice.payment_succeeded' ? 'stripe_subscription' : 'stripe_checkout',
    externalId,
    payoutMode: 'offchain_fiat',
    meta:       { stripeEvent: event.type }
  }).catch(() => {});

  res.json({ received: true });
});

// ── Root: referral config per tenant ─────────────────────────────────────────
app.post('/root/tenants/referral', async (req, res) => {
  const { rootPassword, tenantId, refCode, refPercent } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants', buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }

  const tenants = loadTenantsRegistry();
  const idx     = tenants.findIndex((t) => t.id === tenantId);
  if (idx === -1) {
    return res.status(404).render('root-tenants', buildRootViewModel({ error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }

  const cleanCode    = (refCode || '').trim();
  const percent      = Math.min(0.5, Math.max(0, parseFloat(refPercent) || 0.1));
  tenants[idx].referral = cleanCode ? { code: cleanCode, percent } : null;
  saveTenantsRegistry(tenants);

  // Ensure account record & sync with core
  if (cleanCode) {
    const accounts = ensureReferralAccount(cleanCode, percent);
    if (!accounts[cleanCode].tenants.includes(tenantId)) accounts[cleanCode].tenants.push(tenantId);
    accounts[cleanCode].percent = percent;
    saveReferralAccounts(accounts);
    coreReferralRegister(tenantId, cleanCode, percent).catch(() => {});
  }

  console.log(`[Referral] Updated referral for tenant ${tenantId}: code=${cleanCode} percent=${percent}`);
  res.render('root-tenants', buildRootViewModel({ message: `Referral για τον tenant "${tenantId}" αποθηκεύτηκε.` }));
});

// ── Root: referral account fiat method update ─────────────────────────────────
app.post('/root/referral/account', (req, res) => {
  const { rootPassword, code, payoutMode, iban, holder, wallet } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants', buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }
  const accounts = loadReferralAccounts();
  if (!accounts[code]) {
    return res.status(404).render('root-tenants', buildRootViewModel({ error: `Referral account "${code}" δεν βρέθηκε.` }));
  }
  accounts[code].payoutMode  = payoutMode || 'offchain_fiat';
  accounts[code].wallet      = (wallet || '').trim() || null;
  accounts[code].fiatMethod  = { type: 'bank', iban: (iban || '').trim(), holder: (holder || '').trim() };
  saveReferralAccounts(accounts);

  res.render('root-tenants', buildRootViewModel({ message: `Account "${code}" ενημερώθηκε.` }));
});

// ── Root: mark earning(s) as paid ────────────────────────────────────────────
app.post('/root/referral/mark-paid', (req, res) => {
  const { rootPassword, earningId, refCode, paidVia, txId } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants', buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }

  const earnings  = loadReferralEarnings();
  const paidAt    = new Date().toISOString();
  let   totalPaid = 0;

  // If earningId given, mark single; if refCode given, mark all pending for that code
  earnings.forEach((e) => {
    const match = earningId ? e.id === earningId : (e.refCode === refCode && e.status === 'pending');
    if (match && e.status === 'pending') {
      e.status  = 'paid';
      e.paidAt  = paidAt;
      e.paidVia = (paidVia || 'bank').trim();
      e.txId    = (txId || '').trim() || null;
      totalPaid = +(totalPaid + e.amountFiat).toFixed(2);
    }
  });
  saveReferralEarnings(earnings);

  // Update account totals
  const codeToUpdate = earningId
    ? (earnings.find((e) => e.id === earningId) || {}).refCode
    : refCode;
  if (codeToUpdate) {
    const accounts = loadReferralAccounts();
    if (accounts[codeToUpdate]) {
      accounts[codeToUpdate].totals.paidFiat = +(accounts[codeToUpdate].totals.paidFiat + totalPaid).toFixed(2);
      saveReferralAccounts(accounts);
    }
  }

  res.render('root-tenants', buildRootViewModel({ message: `Πληρωμή ${totalPaid.toFixed(2)} € καταγράφηκε.` }));
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Thronos Commerce running on port ${PORT}`);
});
