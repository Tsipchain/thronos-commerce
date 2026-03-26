const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');

function safeRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}
const nodemailer = safeRequire('nodemailer');
const StripeLib  = safeRequire('stripe');

// ── Stripe helpers ────────────────────────────────────────────────────────────
function stripeForTenant(config) {
  const key = (config.stripeSecretKey || '').trim();
  if (!key || !StripeLib) return null;
  try { return StripeLib(key); } catch (e) { return null; }
}

// Platform-level Stripe (for selling Thronos subscriptions)
function platformStripe() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key || !StripeLib) return null;
  try { return StripeLib(key); } catch (e) { return null; }
}

// Subscription info from tenant record
const PACKAGE_PRICES = { MANAGEMENT_START: 49, FULL_OPS_START: 149, DIGITAL_STARTER: 79, DIGITAL_PRO: 199 };

function getSubscriptionInfo(tenant) {
  if (!tenant) return null;
  if (!tenant.subscriptionExpiry) {
    return { plan: tenant.supportTier, status: 'manual', daysLeft: null, isExpired: false, isExpiringSoon: false, expiryStr: null };
  }
  const expiry   = new Date(tenant.subscriptionExpiry);
  const daysLeft = Math.ceil((expiry - Date.now()) / 86400000);
  return {
    plan:          tenant.subscriptionPlan || tenant.supportTier,
    status:        daysLeft <= 0 ? 'expired' : 'active',
    expiryStr:     expiry.toLocaleDateString('el-GR'),
    daysLeft:      Math.max(0, daysLeft),
    isExpired:     daysLeft <= 0,
    isExpiringSoon: daysLeft > 0 && daysLeft <= 7
  };
}

// ── i18n ─────────────────────────────────────────────────────────────────────
const LOCALES_DIR = path.join(__dirname, 'locales');
const SUPPORTED_LANGS = ['el', 'en'];
const CONTENT_LANGS = ['el', 'en'];
const DEFAULT_CONTENT_LANG = 'el';
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
  const sLang = (req.session && req.session.lang ? String(req.session.lang) : '').toLowerCase();
  if (SUPPORTED_LANGS.includes(sLang)) return sLang;
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

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTranslatableObject(value) {
  if (!isPlainObject(value)) return false;
  return CONTENT_LANGS.some((l) => typeof value[l] === 'string');
}

function resolveTranslatable(value, lang = DEFAULT_CONTENT_LANG, fallbackLang = DEFAULT_CONTENT_LANG) {
  if (typeof value === 'string') return value;
  if (!isTranslatableObject(value)) return value;
  const primary = typeof value[lang] === 'string' ? value[lang].trim() : '';
  if (primary) return primary;
  const fallback = typeof value[fallbackLang] === 'string' ? value[fallbackLang].trim() : '';
  if (fallback) return fallback;
  for (const l of CONTENT_LANGS) {
    if (typeof value[l] === 'string' && value[l].trim()) return value[l].trim();
  }
  return '';
}

function buildTranslatableFromBody(body, baseName, fallbackValue) {
  const result = {};
  for (const lang of CONTENT_LANGS) {
    const v = body[`${baseName}_${lang}`];
    if (typeof v === 'string' && v.trim()) result[lang] = v.trim();
  }
  if (Object.keys(result).length) return result;
  if (typeof body[baseName] === 'string' && body[baseName].trim()) return body[baseName].trim();
  return fallbackValue;
}

function normalizeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isUrlSafeSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || ''));
}

function isEukolakisClassicPreset(req) {
  if (!req || !req.tenant || req.tenant.id !== 'eukolakis') return false;
  const config = loadTenantConfig(req);
  const presetId = config && config.theme && config.theme.presetId;
  return presetId === 'eukolakis_classic_diy';
}

const EUKOLAKIS_CORE_CATEGORY_IDS = new Set(['diy-rolla', 'diy-sliding', 'spare-parts']);
function shouldDefaultPartsOnly(tenant, config) {
  return tenant && tenant.id === 'eukolakis' && config && config.theme && config.theme.presetId === 'eukolakis_classic_diy';
}

function localizeConfigContent(config, lang) {
  return {
    ...config,
    storeName: resolveTranslatable(config.storeName, lang),
    heroText: resolveTranslatable(config.heroText, lang),
    heroTitle: resolveTranslatable(config.heroTitle, lang),
    heroSubtitle: resolveTranslatable(config.heroSubtitle, lang)
  };
}

function localizeCategoryContent(cat, lang) {
  return {
    ...cat,
    name: resolveTranslatable(cat.name, lang),
    shortDescription: resolveTranslatable(cat.shortDescription, lang)
  };
}

function localizeProductContent(product, lang) {
  return {
    ...product,
    name: resolveTranslatable(product.name, lang),
    description: resolveTranslatable(product.description, lang)
  };
}

function hydrateKitProduct(product, catalog, lang = DEFAULT_CONTENT_LANG, options = {}) {
  if (!product || product.type !== 'KIT' || !Array.isArray(product.kitOptions)) return product;
  const kitPayMode = product.kitPayMode || (options.defaultPartsOnly ? 'parts_only' : 'bundle');
  const hydratedOptions = product.kitOptions.map((group) => {
    const choices = Array.isArray(group.choices) ? group.choices : [];
    const hydratedChoices = choices.map((choice) => {
      const linked = choice.linkedProductId ? catalog.find((p) => p.id === choice.linkedProductId) : null;
      const linkedName = linked ? resolveTranslatable(linked.name, lang) : '';
      const linkedDescription = linked ? resolveTranslatable(linked.description, lang) : '';
      const linkedPrice = linked ? (Number(linked.price) || 0) : 0;
      const linkedVariants = linked && Array.isArray(linked.variants)
        ? linked.variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku || '',
          label: resolveTranslatable(variant.label, lang) || variant.id,
          price: Number(variant.price),
          stock: variant.stock === undefined ? null : Number(variant.stock),
          imageUrl: variant.imageUrl || ''
        }))
        : [];
      const isSkipChoice = choice.id === 'skip';
      const computedPriceDelta = kitPayMode === 'parts_only'
        ? (isSkipChoice ? 0 : linkedPrice)
        : (choice.useLinkedPriceDelta && linked ? linkedPrice : (Number(choice.priceDelta) || 0));
      return {
        ...choice,
        label: (choice.label || '').trim() || linkedName || choice.id,
        description: (choice.description || '').trim() || (linkedDescription ? linkedDescription.slice(0, 140) : ''),
        image: (choice.image || '').trim() || (linked && linked.imageUrl ? linked.imageUrl : ''),
        priceDelta: computedPriceDelta,
        linkedPrice,
        linkedName: linkedName || '',
        linkedImageUrl: linked && linked.imageUrl ? linked.imageUrl : '',
        linkedVariants
      };
    });
    if (group.allowSkip && !hydratedChoices.some((c) => c.id === 'skip')) {
      hydratedChoices.push({ id: 'skip', label: 'Δεν το χρειάζομαι / Το έχω ήδη', description: '', image: '', priceDelta: 0, linkedProductId: '', linkedPrice: 0 });
    }
    return { ...group, choices: hydratedChoices };
  });
  return { ...product, kitPayMode, kitOptions: hydratedOptions };
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
const TEMPLATES_DIR = path.join(DATA_ROOT, 'templates');
ensureDir(TEMPLATES_DIR);

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
  const backups = path.join(base, 'backups');
  ensureDir(backups);
  return {
    base,
    config: path.join(base, 'config.json'),
    products: path.join(base, 'products.json'),
    categories: path.join(base, 'categories.json'),
    users: path.join(base, 'users.json'),
    orders: path.join(base, 'orders.json'),
    reviews: path.join(base, 'reviews.json'),
    stockLog:      path.join(base, 'stock_log.json'),
    analytics:     path.join(base, 'analytics.json'),
    favicon:       path.join(base, 'favicon.png'),
    pendingOrders: path.join(base, 'pending_orders.json'),
    tickets:       path.join(base, 'tickets.json'),
    media,
    backups
  };
}

function backupJsonWithRotation(req, type, data, keep = 20) {
  const safeType = String(type || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'data';
  const now = new Date();
  const ts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  ].join('') + '-' + [
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0')
  ].join('');
  const filename = `${safeType}-${ts}.json`;
  const target = path.join(req.tenantPaths.backups, filename);
  fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
  const files = fs.readdirSync(req.tenantPaths.backups)
    .filter((f) => f.startsWith(`${safeType}-`) && f.endsWith('.json'))
    .sort()
    .reverse();
  files.slice(keep).forEach((f) => {
    try { fs.unlinkSync(path.join(req.tenantPaths.backups, f)); } catch (_) {}
  });
}

function listRecentBackups(req, limit = 40) {
  const files = fs.readdirSync(req.tenantPaths.backups)
    .filter((f) => /^[a-z0-9_-]+-\d{8}-\d{6}\.json$/i.test(f))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((filename) => {
      const full = path.join(req.tenantPaths.backups, filename);
      const stat = fs.statSync(full);
      return {
        filename,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        type: filename.split('-')[0]
      };
    });
  return files;
}

function hasExportAccess(req) {
  if (req.session && req.session.rootAdmin) return true;
  const tier = req.tenant && req.tenant.supportTier;
  if (tier && tier !== 'SELF_SERVICE') return true;
  const sub = getSubscriptionInfo(req.tenant || {});
  const status = String((req.tenant && req.tenant.subscriptionStatus) || '').toLowerCase();
  return status === 'active' || (!!req.tenant.subscriptionExpiry && !sub.isExpired);
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
  return tenants.find(
    (t) =>
      t.domain &&
      t.domain.toLowerCase() === host
  );
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
      buttonRadius: '4px',
      headerLayout: 'default',
      heroStyle: 'soft',
      categoryMenuStyle: 'image_label',
      cardStyle: 'soft',
      sectionSpacing: 'normal',
      bannerVisible: true,
      previewBadgeStyle: 'soft',
      cursorEffect: false,
      cursorImage: '',
      brandingMode: 'logo_name',
      logoDisplayMode: 'contain',
      logoBgMode: 'auto',
      logoPadding: 6,
      logoRadius: 10,
      logoShadow: 'soft',
      logoMaxHeight: 52
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

function loadTenantUsers(req) {
  const users = loadJson(req.tenantPaths.users, []);
  return Array.isArray(users) ? users : [];
}

function saveTenantUsers(req, users) {
  saveJson(req.tenantPaths.users, users);
}

function saveTenantProducts(req, products) {
  saveJson(req.tenantPaths.products, products);
  backupJsonWithRotation(req, 'products', products);
}

function saveTenantCategories(req, categories) {
  saveJson(req.tenantPaths.categories, categories);
  backupJsonWithRotation(req, 'categories', categories);
}

function saveTenantConfig(req, config) {
  saveJson(req.tenantPaths.config, config);
  backupJsonWithRotation(req, 'config', config);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--');
}

function safeInlineScriptString(value) {
  return JSON.stringify(String(value))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildTenantLink(req, targetPath, extraQuery = {}) {
  const basePath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  const query = new URLSearchParams();
  if (req.tenantContext && req.tenantContext.mode === 'query' && req.tenantId) {
    query.set('tenant', req.tenantId);
  }
  const carryLang = (req.lang || '').toLowerCase();
  if (SUPPORTED_LANGS.includes(carryLang) && !Object.prototype.hasOwnProperty.call(extraQuery || {}, 'lang')) {
    query.set('lang', carryLang);
  }
  if (
    basePath.startsWith('/admin') &&
    req.session &&
    req.session.contentLang &&
    CONTENT_LANGS.includes(String(req.session.contentLang).toLowerCase()) &&
    !Object.prototype.hasOwnProperty.call(extraQuery || {}, 'contentLang')
  ) {
    query.set('contentLang', String(req.session.contentLang).toLowerCase());
  }
  Object.entries(extraQuery || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') query.set(k, String(v));
  });
  const qs = query.toString();
  if (req.tenantContext && req.tenantContext.mode === 'path' && req.tenantId) {
    return `/t/${req.tenantId}${basePath}${qs ? `?${qs}` : ''}`;
  }
  return `${basePath}${qs ? `?${qs}` : ''}`;
}

function requireUser(req, res, next) {
  if (!req.session.user) {
    return res.redirect(buildTenantLink(req, '/login'));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.redirect(buildTenantLink(req, '/admin/login'));
  }
  if (!req.tenant || req.session.admin.tenantId !== req.tenant.id) {
    return res.redirect(buildTenantLink(req, '/admin/login'));
  }
  next();
}

function requireRootAdmin(req, res, next) {
  if (!req.session.rootAdmin) {
    return res.redirect('/root/login');
  }
  next();
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

const ADMIN_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
async function verifyAdminAction(req, providedPassword) {
  const now = Date.now();
  const last = Number(req.session && req.session.adminLastActiveAt ? req.session.adminLastActiveAt : 0);
  const isFresh = !!last && (now - last) <= ADMIN_IDLE_TIMEOUT_MS;
  if (req.session && req.session.admin && req.session.admin.tenantId === req.tenant.id && isFresh) {
    req.session.adminLastActiveAt = now;
    return { ok: true };
  }
  const ok = await verifyAdminPassword(req.tenant, providedPassword || '');
  if (ok) {
    if (req.session) req.session.adminLastActiveAt = now;
    return { ok: true, reauthenticated: true };
  }
  return { ok: false, needsPassword: true };
}

// Root operator auth
const ROOT_ADMIN_PASSWORD = process.env.THRONOS_ROOT_ADMIN_PASSWORD || '';

function verifyRootPassword(plain) {
  if (!ROOT_ADMIN_PASSWORD) return false;
  const a = Buffer.from(plain || '');
  const b = Buffer.from(ROOT_ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sanitizeTemplateId(raw) {
  return (raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function listThemeTemplates() {
  const out = [];
  try {
    const entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true });
    entries.filter((e) => e.isDirectory()).forEach((entry) => {
      const metaFile = path.join(TEMPLATES_DIR, entry.name, 'template.json');
      if (fs.existsSync(metaFile)) {
        const meta = loadJson(metaFile, null);
        if (meta && meta.id) out.push(meta);
      }
    });
  } catch (_) {}
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function extractThemeSkeletonConfig(config) {
  return {
    primaryColor: config.primaryColor || '#222222',
    accentColor: config.accentColor || '#00ff88',
    fontFamily: config.fontFamily || "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    theme: config.theme || {
      menuBg: '#111111',
      menuText: '#ffffff',
      menuActiveBg: '#f06292',
      menuActiveText: '#ffffff',
      buttonRadius: '4px'
    }
  };
}

function saveTemplateFromTenant(templateId, tenantId, displayName) {
  const clean = sanitizeTemplateId(templateId);
  if (!clean) throw new Error('invalid template id');
  const srcPaths = tenantPaths(tenantId);
  const srcCfg = loadJson(srcPaths.config, {});
  const dir = path.join(TEMPLATES_DIR, clean);
  ensureDir(dir);
  const tpl = {
    id: clean,
    name: (displayName || clean).trim(),
    sourceTenantId: tenantId,
    createdAt: new Date().toISOString(),
    themeConfig: extractThemeSkeletonConfig(srcCfg)
  };
  saveJson(path.join(dir, 'template.json'), tpl);
  return tpl;
}

// Seed a new tenant's files from a template tenant (default: 'demo')
function seedTenantFilesFromTemplate(tenantId, templateId = 'demo') {
  const newPaths = tenantPaths(tenantId);
  const templateMeta = loadJson(path.join(TEMPLATES_DIR, sanitizeTemplateId(templateId), 'template.json'), null);
  const tplPaths = tenantPaths(templateId);

  const baseConfig = {
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
  };

  if (!fs.existsSync(newPaths.config)) {
    let nextConfig = Object.assign({}, baseConfig);
    if (templateMeta && templateMeta.themeConfig) {
      nextConfig = Object.assign(nextConfig, templateMeta.themeConfig);
    } else {
      const tplConfig = loadJson(tplPaths.config, baseConfig);
      nextConfig = Object.assign({}, nextConfig, extractThemeSkeletonConfig(tplConfig));
      nextConfig.shippingOptions = tplConfig.shippingOptions || [];
      nextConfig.paymentOptions = tplConfig.paymentOptions || [];
    }
    nextConfig.storeName = tenantId;
    saveJson(newPaths.config, nextConfig);
  }

  if (!fs.existsSync(newPaths.products)) {
    saveJson(newPaths.products, []);
  }

  if (!fs.existsSync(newPaths.categories)) {
    saveJson(newPaths.categories, []);
  }
  if (!fs.existsSync(newPaths.orders)) saveJson(newPaths.orders, []);
  if (!fs.existsSync(newPaths.users)) saveJson(newPaths.users, []);
  if (!fs.existsSync(newPaths.tickets)) saveJson(newPaths.tickets, []);
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

  const storeName = resolveTranslatable(config.storeName, DEFAULT_CONTENT_LANG);
  const fromName = config.notificationFromName || storeName || 'Thronos Commerce Store';
  const from = `"${fromName}" <${process.env.THRC_SMTP_FROM || process.env.THRC_SMTP_USER}>`;
  const subject = `[${tenant.id}] Νέα παραγγελία #${order.id} – ${order.productName}`;

  const lines = [
    `Κατάστημα: ${storeName} (${tenant.domain || tenant.id})`,
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
  const storeName = resolveTranslatable(config.storeName, DEFAULT_CONTENT_LANG);
  const fromName = storeName || 'Thronos Commerce';
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
        text: `Νέα παραγγελία στο κατάστημα ${storeName}!\n\n${bodyLines}`
      })
    );
  }

  if (order.email) {
    sends.push(
      transport.sendMail({
        from,
        to: order.email,
        subject: `Επιβεβαίωση παραγγελίας #${order.id} – ${storeName}`,
        text: `Γεια σας ${order.customerName},\n\nΛάβαμε την παραγγελία σας!\n\n${bodyLines}\n\nΕυχαριστούμε!\n${storeName}`
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
const partsUpload = multer({
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(String(file.mimetype || ''))),
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join((req.tenantPaths && req.tenantPaths.media) || path.join(TENANTS_DIR, '_uploads'), 'parts');
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      const base = path.basename(file.originalname || 'part', ext).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      cb(null, `${Date.now()}-${base}${ext}`);
    }
  })
});
const categoryUpload = multer({
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\//.test(String(file.mimetype || '')));
  },
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join((req.tenantPaths && req.tenantPaths.media) || path.join(TENANTS_DIR, '_uploads'), 'categories');
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      const base = path.basename(file.originalname || 'category', ext).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      cb(null, `${Date.now()}-${base}${ext}`);
    }
  })
});

// Separate multer for favicon (memory storage, 512 KB limit)
const favUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpeg|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(file.mimetype);
    cb(null, ok);
  }
});
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }
});

// View engine & middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security headers
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/tenants', express.static(TENANTS_DIR));
// Raw body for Stripe webhook signature verification (must be before urlencoded)
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'thronos-secret',
  resave: false,
  saveUninitialized: false
}));

// i18n middleware – sets req.lang, res.locals.lang, res.locals.t
app.use((req, res, next) => {
  const match = req.url.match(/^\/t\/([a-zA-Z0-9_-]+)(\/.*|$)/);
  req.pathTenantId = match ? match[1] : null;
  if (match) {
    const rest = match[2] || '';
    req.url = (rest || '/') + req.url.slice(match[0].length);
  }
  next();
});

app.use((req, res, next) => {
  req.lang = getLangFromRequest(req);
  if (req.session) req.session.lang = req.lang;
  res.locals.lang = req.lang;
  res.locals.t = (key) => translate(req.lang, key);
  res.locals.contentLangs = CONTENT_LANGS;
  res.locals.resolveField = (value, lang = req.lang) => resolveTranslatable(value, lang);
  next();
});

// Tenant resolution middleware (skips root operator panel)
app.use((req, res, next) => {
  if (req.path.startsWith('/root')) return next();
  const hostHeader = (req.headers.host || '').split(':')[0];
  const requestedTenant = (req.query.tenant || '').trim();
  let tenant = null;
  let mode = 'host';
  if (req.pathTenantId) {
    tenant = findTenantById(req.pathTenantId);
    mode = 'path';
  } else if (requestedTenant) {
    tenant = findTenantById(requestedTenant);
    mode = 'query';
  } else if (req.path.startsWith('/admin') && req.session.admin && req.session.admin.tenantId) {
    tenant = findTenantById(req.session.admin.tenantId);
    mode = 'admin-session';
  } else {
    tenant = getTenantByHost(hostHeader);
  }
  if (!tenant) {
    tenant = findTenantById('demo');
    mode = mode === 'host' ? 'demo-fallback' : mode;
  }
  if (!tenant) {
    return res
      .status(503)
      .send('No tenant configured for this host. Check tenants.json.');
  }
  req.tenant = tenant;
  req.tenantId = tenant.id;
  req.tenantContext = { mode };
  req.isPlatformRequest = mode === 'demo-fallback' && !req.pathTenantId && !requestedTenant;
  req.tenantPaths = tenantPaths(tenant.id);
  res.locals.user = req.session ? req.session.user : null;
  res.locals.tenantId = tenant.id;
  res.locals.tenantContext = req.tenantContext;
  res.locals.tenantBasePath = req.tenantContext.mode === 'path' ? `/t/${tenant.id}` : '';
  res.locals.isPreviewMode = req.tenantContext.mode === 'path' || req.tenantContext.mode === 'query';
  res.locals.withTenantLink = (path, extra) => buildTenantLink(req, path, extra);
  next();
});

// Root admin auth guard
app.use('/root', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  return requireRootAdmin(req, res, next);
});

// Tenant admin auth guard
app.use('/admin', (req, res, next) => {
  if (req.isPlatformRequest) return res.redirect('/');
  if (req.path === '/login' || req.path === '/logout') return next();
  return requireAdmin(req, res, next);
});

function buildAdminViewModel(req, extra) {
  const config = loadTenantConfig(req);
  const products = loadTenantProducts(req);
  const categories = loadTenantCategories(req);
  const qContentLang = (req.query.contentLang || '').toLowerCase();
  const sContentLang = (req.session && req.session.contentLang ? String(req.session.contentLang) : '').toLowerCase();
  const contentLang = CONTENT_LANGS.includes(qContentLang)
    ? qContentLang
    : (CONTENT_LANGS.includes(sContentLang) ? sContentLang : DEFAULT_CONTENT_LANG);
  if (req.session) req.session.contentLang = contentLang;
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

  const tickets = loadJson(req.tenantPaths.tickets, []);

  return {
    tenant: req.tenant,
    permissions,
    config: localizeConfigContent(config, contentLang),
    rawConfig: config,
    categories: categories.map((c) => localizeCategoryContent(c, contentLang)),
    rawCategories: categories,
    products: products.map((p) => localizeProductContent(p, contentLang)),
    rawProducts: products,
    productsJson: JSON.stringify(products, null, 2),
    productsJsonScript: safeJsonForScript(products),
    productsJsonEscaped: safeInlineScriptString(JSON.stringify(products)),
    contentLang,
    contentLangs: CONTENT_LANGS,
    stockLog: stockLog.slice(-100).reverse(),
    analytics,
    orderCounts,
    cityCounts,
    hasFavicon: fs.existsSync(req.tenantPaths.favicon),
    subscription: getSubscriptionInfo(req.tenant),
    exportAccess: hasExportAccess(req),
    backups: listRecentBackups(req, 30),
    tickets: tickets.slice().reverse(),
    message: null,
    error: null,
    ...(extra || {})
  };
}

function buildAdminPaymentsViewModel(req, extra) {
  const config = loadTenantConfig(req);
  const permissions = getSupportPermissions(req.tenant.supportTier);
  return {
    tenant: req.tenant,
    config,
    permissions,
    ...(extra || {})
  };
}

function renderExportBlockedPage(req, res) {
  const supportEmail = process.env.SUPPORT_EMAIL || 'support@thronoschain.org';
  res.status(403).send(`<!doctype html><html><head><meta charset="utf-8"><title>Export locked</title></head><body style="font-family:Arial,sans-serif;padding:24px;">
    <h2>Export available on paid plans</h2>
    <p>Contact support / upgrade to unlock exports for this tenant.</p>
    <p><a href="mailto:${supportEmail}">${supportEmail}</a></p>
    <p><a href="${buildTenantLink(req, '/admin')}">← Back to admin</a></p>
  </body></html>`);
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
  if (req.isPlatformRequest) {
    return res.render('landing', {
      packages: getLandingPackages(),
      message: null,
      previewTenants: loadTenantsRegistry().map((t) => t.id)
    });
  }
  if (req.query.admin === 'true') {
    return res.redirect(buildTenantLink(req, '/admin'));
  }
  const config = loadTenantConfig(req);
  const categories = loadTenantCategories(req);
  const allProducts = loadTenantProducts(req);
  const hydratedAllProducts = allProducts.map((p) => hydrateKitProduct(p, allProducts, req.lang, {
    defaultPartsOnly: shouldDefaultPartsOnly(req.tenant, config)
  }));

  const rawCategory = String(req.query.category || '');
  let catSlug = normalizeSlug(rawCategory);
  if (req.tenant.id === 'eukolakis') {
    const aliasMap = { spare: 'spare-parts' };
    catSlug = aliasMap[catSlug] || catSlug;
  }
  let products = hydratedAllProducts;

  if (catSlug) {
    const cat = categories.find((c) => normalizeSlug(c.slug) === catSlug || normalizeSlug(c.id) === catSlug);
    if (cat) {
      products = hydratedAllProducts.filter((p) => p.categoryId === cat.id);
    } else {
      products = [];
    }
  }

  const viewLang = req.lang;
  const localizedConfig = localizeConfigContent(config, viewLang);
  const localizedAllProducts = hydratedAllProducts.map((p) => localizeProductContent(p, viewLang));
  res.render('index', {
    config: localizedConfig,
    categories: categories.map((c) => localizeCategoryContent(c, viewLang)),
    products: products.map((p) => localizeProductContent(p, viewLang)),
    allProducts: localizedAllProducts,
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

  const hydratedProduct = hydrateKitProduct(product, products, req.lang, {
    defaultPartsOnly: shouldDefaultPartsOnly(req.tenant, config)
  });
  res.render('product', {
    config: localizeConfigContent(config, req.lang),
    product: localizeProductContent(hydratedProduct, req.lang),
    tenant: req.tenant
  });
});

// Checkout page
app.get('/checkout', (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  res.render('checkout', { config, tenant: req.tenant, user: req.session.user || null });
});

// Checkout submit (multi-item cart)
app.post('/checkout', async (req, res) => {
  const config = loadTenantConfig(req);
  const products = loadTenantProducts(req);
  const {
    name, email, wallet, notes, shippingMethodId, paymentMethodId,
    city, phone, address, doorbell, tk, cartJson
  } = req.body;
  const sessionEmail = req.session.user ? normalizeEmail(req.session.user.email) : '';
  const checkoutEmail = sessionEmail || normalizeEmail(email);

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
    const found = hydrateKitProduct(allProductsCatalog.find((p) => p.id === ci.id), allProductsCatalog, req.lang, {
      defaultPartsOnly: shouldDefaultPartsOnly(req.tenant, config)
    });
    if (found) {
      let serverPrice = Number(found.price) || 0;
      let variantLabel = '';
      let variantId = (ci.variantId || '').trim();
      let selectedOptions = [];
      let optionSummary = '';
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
      if (found.type === 'KIT' && Array.isArray(found.kitOptions)) {
        const rawOptions = Array.isArray(ci.selectedOptions) ? ci.selectedOptions : [];
        const selectedByGroup = {};
        rawOptions.forEach((opt) => {
          const group = found.kitOptions.find((g) => g.id === opt.groupId);
          if (!group) return;
          const choice = (group.choices || []).find((c) => c.id === opt.choiceId);
          if (!choice) return;
          if (!selectedByGroup[group.id]) selectedByGroup[group.id] = [];
          if (group.inputType === 'checkbox') selectedByGroup[group.id].push(choice);
          else selectedByGroup[group.id] = [choice];
        });
        const missingRequired = found.kitOptions.some((g) => g.required && (!selectedByGroup[g.id] || !selectedByGroup[g.id].length));
        if (missingRequired) continue;
        selectedOptions = [];
        found.kitOptions.forEach((group) => {
          (selectedByGroup[group.id] || []).forEach((choice) => {
            const linkedProduct = choice.linkedProductId
              ? allProductsCatalog.find((p) => p.id === choice.linkedProductId)
              : null;
            const selectedVariantIdRaw = rawOptions.find((opt) => opt.groupId === group.id && opt.choiceId === choice.id)?.selectedVariantId;
            const selectedVariantId = typeof selectedVariantIdRaw === 'string' ? selectedVariantIdRaw.trim() : '';
            const linkedVariant = linkedProduct && selectedVariantId && Array.isArray(linkedProduct.variants)
              ? linkedProduct.variants.find((v) => v.id === selectedVariantId)
              : null;
            const variantPrice = linkedVariant && linkedVariant.price !== undefined
              ? Number(linkedVariant.price) || 0
              : null;
            const computedChoicePrice = found.kitPayMode === 'parts_only'
              ? (variantPrice !== null ? variantPrice : (Number(choice.priceDelta) || 0))
              : (choice.useLinkedPriceDelta && linkedProduct
                ? (variantPrice !== null ? variantPrice : (Number(linkedProduct.price) || 0))
                : (Number(choice.priceDelta) || 0));
            selectedOptions.push({
              groupId: group.id,
              groupLabel: group.label || group.id,
              choiceId: choice.id,
              choiceLabel: choice.label || choice.id,
              priceDelta: computedChoicePrice,
              linkedProductId: choice.linkedProductId || null,
              selectedVariantId: linkedVariant ? linkedVariant.id : undefined,
              selectedVariantLabel: linkedVariant ? (resolveTranslatable(linkedVariant.label, req.lang) || linkedVariant.id) : undefined,
              selectedVariantSku: linkedVariant ? (linkedVariant.sku || undefined) : undefined
            });
          });
        });
        const delta = selectedOptions.reduce((s, o) => s + (Number(o.priceDelta) || 0), 0);
        if (found.kitPayMode === 'parts_only') {
          serverPrice = 0;
          if (!ci.isKitSummary) {
            selectedOptions
              .filter((o) => o.linkedProductId)
              .forEach((o) => {
                const linked = allProductsCatalog.find((p) => p.id === o.linkedProductId);
                if (!linked) return;
                const linkedVariant = o.selectedVariantId && Array.isArray(linked.variants)
                  ? linked.variants.find((v) => v.id === o.selectedVariantId)
                  : null;
                const linkedPrice = linkedVariant && linkedVariant.price !== undefined
                  ? Number(linkedVariant.price) || 0
                  : Number(linked.price) || 0;
                const linkedImage = (linkedVariant && linkedVariant.imageUrl) || linked.imageUrl || '';
                const linkedName = resolveTranslatable(linked.name, req.lang);
                const variantLabel = linkedVariant ? (resolveTranslatable(linkedVariant.label, req.lang) || linkedVariant.id) : '';
                enrichedItems.push({
                  id: linked.id,
                  name: variantLabel ? `${linkedName} – ${variantLabel}` : linkedName,
                  variantId: linkedVariant ? linkedVariant.id : undefined,
                  variantLabel: variantLabel || undefined,
                  variantSku: linkedVariant ? (linkedVariant.sku || undefined) : undefined,
                  imageUrl: linkedImage,
                  price: linkedPrice,
                  qty: Math.max(1, parseInt(ci.qty, 10) || 1),
                  sourceKitId: found.id,
                  sourceKitOption: `${o.groupLabel}: ${o.choiceLabel}${variantLabel ? ` (${variantLabel})` : ''}`
                });
              });
          }
        } else {
          serverPrice += delta;
        }
        optionSummary = selectedOptions.map((o) => `${o.groupLabel}: ${o.choiceLabel}`).join(' | ');
      }
      enrichedItems.push({
        id:           found.id,
        name:         found.name,
        variantId:    variantId || undefined,
        variantLabel: variantLabel || undefined,
        selectedOptions: selectedOptions.length ? selectedOptions : undefined,
        optionSummary: optionSummary || undefined,
        basePrice: Number(found.price) || 0,
        finalUnitPrice: serverPrice,
        price:        serverPrice,
        qty:          Math.max(1, parseInt(ci.qty, 10) || 1),
        isKitSummary: found.type === 'KIT' && found.kitPayMode === 'parts_only'
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

  const orderId = Date.now().toString() + '_' + crypto.randomBytes(6).toString('hex');
  const order = {
    id: orderId,
    tenantId: req.tenant.id,
    // Keep single-product fields for backward compat (first item)
    productId:   enrichedItems[0].id,
    productName: enrichedItems.map((i) =>
      i.variantLabel
        ? `${i.name} – ${i.variantLabel}${i.optionSummary ? ` (${i.optionSummary})` : ''} ×${i.qty}`
        : `${i.name}${i.optionSummary ? ` (${i.optionSummary})` : ''} ×${i.qty}`
    ).join(', '),
    price:       enrichedItems[0].price,
    // Multi-item
    items: enrichedItems,
    customerName: name,
    email: checkoutEmail,
    userEmail: sessionEmail || null,
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
    paymentStatus: totals.paymentMethod.type === 'stripe' ? 'PENDING_STRIPE' : 'PENDING_COD',
    createdAt: new Date().toISOString()
  };

  console.log('[Thronos Commerce] New cart order:', JSON.stringify(order));

  // ── Stripe Checkout redirect ──────────────────────────────────────
  if (totals.paymentMethod.type === 'stripe') {
    const stripe = stripeForTenant(config);
    if (stripe) {
      try {
        // Save pending order before redirecting to Stripe
        const pendingId = `po_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const pending   = loadJson(req.tenantPaths.pendingOrders, {});
        pending[pendingId] = { order, enrichedItems };
        saveJson(req.tenantPaths.pendingOrders, pending);

        const baseUrl   = `${req.protocol}://${req.get('host')}`;
        const lineItems = enrichedItems.map((item) => ({
          price_data: {
            currency:     'eur',
            product_data: { name: item.variantLabel ? `${item.name} – ${item.variantLabel}` : item.name },
            unit_amount:  Math.round(item.price * 100)
          },
          quantity: item.qty
        }));
        if (totals.shippingCost > 0) {
          lineItems.push({ price_data: { currency: 'eur', product_data: { name: totals.shippingMethod.label || 'Μεταφορικά' }, unit_amount: Math.round(totals.shippingCost * 100) }, quantity: 1 });
        }
        if (totals.codFee > 0) {
          lineItems.push({ price_data: { currency: 'eur', product_data: { name: 'Επιβάρυνση αντικαταβολής' }, unit_amount: Math.round(totals.codFee * 100) }, quantity: 1 });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode:                 'payment',
          line_items:           lineItems,
          customer_email:       checkoutEmail,
          success_url: `${baseUrl}/checkout/stripe-success?pending_id=${pendingId}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url:  `${baseUrl}/checkout`
        });

        return res.redirect(303, session.url);
      } catch (stripeErr) {
        console.error('[Stripe] create session failed:', stripeErr.message);
        // Fall through to normal order if Stripe fails
      }
    }
  }

  const proofHash = await recordOrderOnChain(order, req.tenant);
  order.proofHash = proofHash;
  appendTenantOrder(req, order);

  // ── Stock deduction (per item) ────────────────────────────────────
  const allProductsMut = loadTenantProducts(req);
  const stockLog = loadJson(req.tenantPaths.stockLog, []);
  enrichedItems.forEach((ci) => {
    if (ci.isKitSummary) return;
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
  const mailSubject = `Νέα παραγγελία #${order.id} – ${resolveTranslatable(config.storeName, DEFAULT_CONTENT_LANG)}`;
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
    config: localizeConfigContent(config, req.lang),
    order,
    proofHash,
    tenant: req.tenant,
    clearCart: true,
    contentUrl: hasDigital ? `/content/${order.id}` : null
  });
});

// ── Stripe success / cancel ───────────────────────────────────────────────────
app.get('/checkout/stripe-success', async (req, res) => {
  const { pending_id, session_id } = req.query;
  const config = loadTenantConfig(req);
  const stripe = stripeForTenant(config);

  if (!stripe || !pending_id || !session_id) return res.redirect(buildTenantLink(req, '/checkout'));

  const pending = loadJson(req.tenantPaths.pendingOrders, {});
  const entry   = pending[pending_id];
  if (!entry) {
    return res.redirect(buildTenantLink(req, '/checkout', { error: 'order_not_found' }));
  }

  // Verify payment
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.redirect(buildTenantLink(req, '/checkout', { error: 'payment_failed' }));
  } catch (err) {
    console.error('[Stripe] retrieve session failed:', err.message);
    return res.redirect(buildTenantLink(req, '/checkout', { error: 'payment_error' }));
  }

  const { order, enrichedItems } = entry;
  order.paymentStatus   = 'PAID';
  order.stripeSessionId = session_id;
  if (req.session.user) {
    order.userEmail = normalizeEmail(req.session.user.email);
  }

  delete pending[pending_id];
  saveJson(req.tenantPaths.pendingOrders, pending);

  const proofHash = await recordOrderOnChain(order, req.tenant);
  order.proofHash = proofHash;
  appendTenantOrder(req, order);

  // Stock deduction
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
        stockLog.push({ id: Date.now().toString(36) + '_s', productId: ci.id, productName: ci.name, variantId: ci.variantId, variantLabel: ci.variantLabel, delta: -ci.qty, reason: 'stripe_order', orderId: order.id, createdAt: order.createdAt });
      }
    } else if ((prod.stock || 0) > 0) {
      prod.stock = Math.max(0, prod.stock - ci.qty);
      stockLog.push({ id: Date.now().toString(36) + '_s', productId: ci.id, productName: ci.name, delta: -ci.qty, reason: 'stripe_order', orderId: order.id, createdAt: order.createdAt });
    }
  });
  saveJson(req.tenantPaths.products, allProductsMut);
  saveJson(req.tenantPaths.stockLog, stockLog);

  if (order.city) {
    try {
      const analytics = loadJson(req.tenantPaths.analytics, { pageViews: {}, cities: {} });
      analytics.cities[order.city] = (analytics.cities[order.city] || 0) + 1;
      saveJson(req.tenantPaths.analytics, analytics);
    } catch (_) {}
  }

  try { await sendOrderEmail({ tenant: req.tenant, config, order }); } catch (_) {}
  try { await sendOrderWebhook({ tenant: req.tenant, config, order }); } catch (_) {}
  sendOrderEmails(order, config).catch(() => {});

  const allProductsForContent = loadTenantProducts(req);
  const hasDigital = enrichedItems.some((ci) => {
    const p = allProductsForContent.find((pp) => pp.id === ci.id);
    return p && p.hasDigitalContent;
  });

  res.render('thanks', {
    config: localizeConfigContent(config, req.lang), order, proofHash, tenant: req.tenant,
    clearCart: true, contentUrl: hasDigital ? `/content/${order.id}` : null
  });
});

app.get('/checkout/stripe-cancel', (req, res) => res.redirect(buildTenantLink(req, '/checkout')));

app.get('/admin/login', (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  if (req.session.admin && req.session.admin.tenantId === req.tenant.id) return res.redirect(buildTenantLink(req, '/admin'));
  res.render('admin-login', { config, tenant: req.tenant, error: null });
});

app.post('/admin/login', async (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  const ok = await verifyAdminPassword(req.tenant, req.body.password);
  if (!ok) return res.status(401).render('admin-login', { config, tenant: req.tenant, error: 'Invalid admin password.' });
  req.session.admin = { tenantId: req.tenant.id, authenticatedAt: new Date().toISOString() };
  req.session.adminLastActiveAt = Date.now();
  res.redirect(buildTenantLink(req, '/admin'));
});

app.get('/admin/logout', (req, res) => {
  req.session.admin = null;
  res.redirect(buildTenantLink(req, '/admin/login'));
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(buildTenantLink(req, '/account'));
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  res.render('login', { config, tenant: req.tenant, error: null });
});

app.post('/login', async (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const users = loadTenantUsers(req);
  const user = users.find((u) => normalizeEmail(u.email) === email);
  if (!user) return res.status(401).render('login', { config, tenant: req.tenant, error: 'Invalid email or password.' });

  const ok = await bcrypt.compare(password, user.passwordHash || '');
  if (!ok) return res.status(401).render('login', { config, tenant: req.tenant, error: 'Invalid email or password.' });

  req.session.user = {
    id: user.id,
    email: user.email
  };
  res.redirect(buildTenantLink(req, '/account'));
});

app.get('/signup', (req, res) => {
  if (req.session.user) return res.redirect(buildTenantLink(req, '/account'));
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  res.render('signup', { config, tenant: req.tenant, error: null });
});

app.post('/signup', async (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const passwordConfirm = String(req.body.passwordConfirm || '');
  if (!email || !password) {
    return res.status(400).render('signup', { config, tenant: req.tenant, error: 'Email and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).render('signup', { config, tenant: req.tenant, error: 'Password must be at least 6 characters.' });
  }
  if (password !== passwordConfirm) {
    return res.status(400).render('signup', { config, tenant: req.tenant, error: 'Password confirmation does not match.' });
  }

  const users = loadTenantUsers(req);
  const exists = users.some((u) => normalizeEmail(u.email) === email);
  if (exists) {
    return res.status(409).render('signup', { config, tenant: req.tenant, error: 'This email is already registered.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: `u_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`, email, passwordHash, createdAt: new Date().toISOString() };
  users.push(user);
  saveTenantUsers(req, users);

  req.session.user = {
    id: user.id,
    email: user.email
  };
  res.redirect(buildTenantLink(req, '/account'));
});

app.get('/account', requireUser, (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  res.render('account', { config, tenant: req.tenant, user: req.session.user });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect(buildTenantLink(req, '/')));
});

app.get('/my-orders', requireUser, (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  const email = normalizeEmail(req.session.user.email);
  const orders = loadTenantOrders(req).filter((o) => normalizeEmail(o.userEmail) === email).slice().reverse();
  res.render('my-orders', { config, tenant: req.tenant, user: req.session.user, orders });
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

app.get('/admin/payments', (req, res) => {
  const extra = {};
  if (req.query.message) extra.message = String(req.query.message);
  if (req.query.error) extra.error = String(req.query.error);
  res.render('admin-payments', buildAdminPaymentsViewModel(req, extra));
});

app.get('/admin/export/products.json', (req, res) => {
  if (!hasExportAccess(req)) return renderExportBlockedPage(req, res);
  const products = loadTenantProducts(req);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${req.tenant.id}-products.json\"`);
  res.send(JSON.stringify(products, null, 2));
});

app.get('/admin/export/products.csv', (req, res) => {
  if (!hasExportAccess(req)) return renderExportBlockedPage(req, res);
  const products = loadTenantProducts(req);
  const esc = (v) => `"${String(v === undefined ? '' : v).replace(/"/g, '""')}"`;
  const rows = [
    ['id', 'name', 'type', 'categoryId', 'sku', 'price', 'stock', 'featured', 'imageUrl'],
    ...products.map((p) => ([
      p.id || '',
      resolveTranslatable(p.name, DEFAULT_CONTENT_LANG),
      p.type || 'NORMAL',
      p.categoryId || '',
      p.sku || '',
      Number(p.price) || 0,
      p.stock === undefined ? '' : Number(p.stock),
      p.featured ? '1' : '0',
      p.imageUrl || ''
    ]))
  ];
  const csv = rows.map((row) => row.map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${req.tenant.id}-products.csv\"`);
  res.send(csv);
});

app.get('/admin/export/categories.json', (req, res) => {
  if (!hasExportAccess(req)) return renderExportBlockedPage(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${req.tenant.id}-categories.json\"`);
  res.send(JSON.stringify(loadTenantCategories(req), null, 2));
});

app.get('/admin/export/config.json', (req, res) => {
  if (!hasExportAccess(req)) return renderExportBlockedPage(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${req.tenant.id}-config.json\"`);
  res.send(JSON.stringify(loadTenantConfig(req), null, 2));
});

app.post('/admin/backups/create-now', async (req, res) => {
  const auth = await verifyAdminAction(req, req.body.password);
  if (!auth.ok) return res.status(401).render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' }));
  backupJsonWithRotation(req, 'products', loadTenantProducts(req));
  backupJsonWithRotation(req, 'categories', loadTenantCategories(req));
  backupJsonWithRotation(req, 'config', loadTenantConfig(req));
  return res.render('admin', buildAdminViewModel(req, { message: 'Δημιουργήθηκε backup snapshot.' }));
});

app.get('/admin/backups/:filename', (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[a-z0-9_-]+-\d{8}-\d{6}\.json$/i.test(filename)) return res.status(400).send('Invalid filename');
  const full = path.join(req.tenantPaths.backups, filename);
  if (!fs.existsSync(full)) return res.status(404).send('Backup not found');
  res.download(full, filename);
});

app.post('/admin/backups/restore', async (req, res) => {
  const { filename, password } = req.body;
  if (!filename || !/^[a-z0-9_-]+-\d{8}-\d{6}\.json$/i.test(filename)) {
    return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Μη έγκυρο backup αρχείο.' }));
  }
  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) return res.status(401).render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' }));
  const full = path.join(req.tenantPaths.backups, filename);
  if (!fs.existsSync(full)) return res.status(404).render('admin', buildAdminViewModel(req, { error: 'Το backup δεν βρέθηκε.' }));
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (filename.startsWith('products-')) {
      saveTenantProducts(req, Array.isArray(parsed) ? parsed : []);
    } else if (filename.startsWith('categories-')) {
      saveTenantCategories(req, Array.isArray(parsed) ? parsed : []);
    } else if (filename.startsWith('config-')) {
      saveTenantConfig(req, parsed && typeof parsed === 'object' ? parsed : {});
    } else {
      return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Μη υποστηριζόμενο backup type.' }));
    }
    return res.render('admin', buildAdminViewModel(req, { message: `Επαναφέρθηκε το backup ${filename}.` }));
  } catch (err) {
    return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Αποτυχία restore: ' + err.message }));
  }
});

app.post('/admin/import/products', importUpload.single('file'), async (req, res) => {
  const auth = await verifyAdminAction(req, req.body.password);
  if (!auth.ok) return res.status(401).render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' }));
  if (!req.file) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'No import file uploaded.' }));
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (!['.csv', '.xlsx'].includes(ext)) {
    return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Allowed formats: csv, xlsx' }));
  }
  if (ext === '.xlsx') {
    return res.status(400).render('admin', buildAdminViewModel(req, { error: 'XLSX import preview is not enabled in this build yet. Please export/save as CSV.' }));
  }
  const text = req.file.buffer.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'CSV has no rows.' }));
  const headers = lines[0].split(',').map((h) => h.trim());
  const idx = (name) => headers.indexOf(name);
  const required = ['id', 'type', 'categoryId', 'name_el', 'name_en', 'price', 'stock', 'imageUrl', 'sku'];
  const missingCols = required.filter((c) => idx(c) === -1);
  if (missingCols.length) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Missing columns: ' + missingCols.join(', ') }));
  const errors = [];
  const imported = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',');
    const row = {
      id: (cols[idx('id')] || '').trim(),
      type: (cols[idx('type')] || 'NORMAL').trim().toUpperCase(),
      categoryId: (cols[idx('categoryId')] || '').trim(),
      nameEl: (cols[idx('name_el')] || '').trim(),
      nameEn: (cols[idx('name_en')] || '').trim(),
      price: Number(cols[idx('price')] || 0),
      stock: Number(cols[idx('stock')] || 0),
      imageUrl: (cols[idx('imageUrl')] || '').trim(),
      sku: (cols[idx('sku')] || '').trim()
    };
    if (!row.id || !row.nameEl) {
      errors.push(`Row ${i + 1}: id and name_el are required`);
      continue;
    }
    imported.push({
      id: row.id,
      type: ['NORMAL', 'PART', 'KIT'].includes(row.type) ? row.type : 'NORMAL',
      categoryId: row.categoryId || undefined,
      name: row.nameEn ? { el: row.nameEl, en: row.nameEn } : row.nameEl,
      price: Number.isFinite(row.price) ? row.price : 0,
      stock: Number.isFinite(row.stock) ? row.stock : 0,
      imageUrl: row.imageUrl || undefined,
      sku: row.sku || undefined
    });
  }
  if (errors.length) {
    return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Import errors: ' + errors.join(' | ') }));
  }
  saveTenantProducts(req, imported);
  return res.render('admin', buildAdminViewModel(req, { message: `Imported ${imported.length} products from CSV.` }));
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
    heroTitle,
    heroSubtitle,
    homepageHeroImage,
    homepageFeaturedIds,
    homepageFeaturedPrimary,
    homepageFeaturedPrimary1,
    homepageFeaturedPrimary2,
    homepageFeaturedSecondaryId,
    homepageSecondaryTitle,
    homepageSecondaryText,
    homepageSecondaryLink,
    homepageSecondaryImage,
    homepageShowSubscriptionsCard,
    web3Domain,
    logoPath,
    themeMenuBg,
    themeMenuText,
    themeMenuActiveBg,
    themeMenuActiveText,
    themeButtonRadius
    ,
    themeHeaderLayout,
    themeHeroStyle,
    themeCategoryMenuStyle,
    themeCardStyle,
    themeSectionSpacing,
    themeBannerVisible,
    themePreviewBadgeStyle,
    themeCursorEffect,
    themeBrandingMode,
    themeLogoDisplayMode,
    themeLogoBgMode,
    themeLogoPadding,
    themeLogoRadius,
    themeLogoShadow,
    themeLogoMaxHeight,
    themeCursorImage
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

  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' })
      );
  }

  const config = loadTenantConfig(req);
  config.storeName = buildTranslatableFromBody(req.body, 'storeName', storeName || config.storeName);
  config.primaryColor = primaryColor || config.primaryColor;
  config.accentColor = accentColor || config.accentColor;
  config.fontFamily = fontFamily || config.fontFamily;
  config.heroText = buildTranslatableFromBody(req.body, 'heroText', heroText || config.heroText);
  config.heroTitle = buildTranslatableFromBody(req.body, 'heroTitle', heroTitle || config.heroTitle || config.storeName);
  config.heroSubtitle = buildTranslatableFromBody(req.body, 'heroSubtitle', heroSubtitle || config.heroSubtitle || config.heroText);
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
  config.theme.headerLayout = themeHeaderLayout || config.theme.headerLayout || 'default';
  config.theme.heroStyle = themeHeroStyle || config.theme.heroStyle || 'soft';
  config.theme.categoryMenuStyle = themeCategoryMenuStyle || config.theme.categoryMenuStyle || 'image_label';
  config.theme.cardStyle = themeCardStyle || config.theme.cardStyle || 'soft';
  config.theme.sectionSpacing = themeSectionSpacing || config.theme.sectionSpacing || 'normal';
  config.theme.bannerVisible = themeBannerVisible === 'on';
  config.theme.previewBadgeStyle = themePreviewBadgeStyle || config.theme.previewBadgeStyle || 'soft';
  config.theme.cursorEffect = themeCursorEffect === 'on';
  config.theme.cursorImage = (themeCursorImage || config.theme.cursorImage || '').trim();
  config.theme.brandingMode = themeBrandingMode || config.theme.brandingMode || 'logo_name';
  config.theme.logoDisplayMode = themeLogoDisplayMode || config.theme.logoDisplayMode || 'contain';
  config.theme.logoBgMode = themeLogoBgMode || config.theme.logoBgMode || 'auto';
  config.theme.logoPadding = Math.max(0, Math.min(24, Number(themeLogoPadding) || Number(config.theme.logoPadding) || 6));
  config.theme.logoRadius = Math.max(0, Math.min(36, Number(themeLogoRadius) || Number(config.theme.logoRadius) || 10));
  config.theme.logoShadow = themeLogoShadow || config.theme.logoShadow || 'soft';
  config.theme.logoMaxHeight = Math.max(28, Math.min(140, Number(themeLogoMaxHeight) || Number(config.theme.logoMaxHeight) || 52));
  config.theme.presetId = req.tenant.id === 'eukolakis' ? 'eukolakis_classic_diy' : (config.theme.presetId || 'default');

  config.homepage = config.homepage || {};
  config.homepage.presetId = req.tenant.id === 'eukolakis' ? 'eukolakis_classic_diy' : (config.homepage.presetId || 'default');
  config.homepage.heroImage = (homepageHeroImage || config.homepage.heroImage || '').trim();
  const legacyFeaturedIds = String(homepageFeaturedIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const featuredPrimaryCombined = [homepageFeaturedPrimary1, homepageFeaturedPrimary2].filter(Boolean).join(',') || homepageFeaturedPrimary || '';
  const featuredPrimary = String(featuredPrimaryCombined || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
  config.homepage.featuredPrimary = featuredPrimary.length ? featuredPrimary : legacyFeaturedIds.slice(0, 2);
  config.homepage.featuredSecondaryId = (homepageFeaturedSecondaryId || config.homepage.featuredSecondaryId || '').trim();
  config.homepage.featuredIds = legacyFeaturedIds;
  config.homepage.secondaryCard = config.homepage.secondaryCard || {};
  config.homepage.secondaryCard.title = buildTranslatableFromBody(req.body, 'homepageSecondaryTitle', homepageSecondaryTitle || config.homepage.secondaryCard.title || '');
  config.homepage.secondaryCard.text = buildTranslatableFromBody(req.body, 'homepageSecondaryText', homepageSecondaryText || config.homepage.secondaryCard.text || '');
  config.homepage.secondaryCard.link = (homepageSecondaryLink || config.homepage.secondaryCard.link || '').trim();
  config.homepage.secondaryCard.image = (homepageSecondaryImage || config.homepage.secondaryCard.image || '').trim();
  config.homepage.showSubscriptionsCard = homepageShowSubscriptionsCard === 'on';

  saveTenantConfig(req, config);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Οι ρυθμίσεις αποθηκεύτηκαν.' })
  );
});

app.post('/admin/notifications', async (req, res) => {
  const { password } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditSettings) {
    return res
      .status(403)
      .render('admin', buildAdminViewModel(req, { error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή ειδοποιήσεων.' }));
  }

  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
    return res
      .status(401)
      .render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' }));
  }

  const config = loadTenantConfig(req);
  config.notificationEmails = (req.body.notificationEmails || '')
    .split('\n')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  config.notificationCcCustomer = req.body.notificationCcCustomer === 'on';
  config.notificationFromName = (req.body.notificationFromName || '').trim();
  config.notificationWebhookUrl = (req.body.notificationWebhookUrl || '').trim();
  config.notificationWebhookSecret = (req.body.notificationWebhookSecret || '').trim();
  saveTenantConfig(req, config);

  return res.render('admin', buildAdminViewModel(req, { message: 'Οι ρυθμίσεις ειδοποιήσεων αποθηκεύτηκαν.' }));
});

app.post('/admin/payments', async (req, res) => {
  const { password } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditSettings) {
    return res.redirect(buildTenantLink(req, '/admin/payments', { error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή πληρωμών.' }));
  }

  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
    return res.redirect(buildTenantLink(req, '/admin/payments', { error: 'Λάθος κωδικός διαχειριστή.' }));
  }

  const config = loadTenantConfig(req);
  config.stripePublishableKey = (req.body.stripePublishableKey || '').trim();
  if (req.body.stripeSecretKey !== undefined) {
    const sk = (req.body.stripeSecretKey || '').trim();
    if (sk) config.stripeSecretKey = sk;
  }
  saveTenantConfig(req, config);

  return res.redirect(buildTenantLink(req, '/admin/payments', { message: 'Τα στοιχεία Stripe αποθηκεύτηκαν.' }));
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

  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
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

  saveTenantConfig(req, config);

  res.render('admin', buildAdminViewModel(req, {
    message: 'Τα μεταφορικά και οι τρόποι πληρωμής αποθηκεύτηκαν.'
  }));
});

// Categories CRUD
app.post('/admin/categories/add', async (req, res) => {
  const { password, id, name, slug, parentId, image, showInMainNav, navOrder } = req.body;
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

  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
    return res
      .status(401)
      .render(
        'admin',
        buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' })
      );
  }

  const categories = loadTenantCategories(req);
  const normalizedId = normalizeSlug(id);
  const normalizedSlug = normalizeSlug(slug || id);
  if (!normalizedId || !normalizedSlug || !isUrlSafeSlug(normalizedSlug)) {
    return res
      .status(400)
      .render('admin', buildAdminViewModel(req, { error: 'Το id/slug πρέπει να είναι URL-safe (πεζά, αριθμοί και παύλες).' }));
  }

  if (categories.some((c) => c.id === normalizedId || c.slug === normalizedSlug)) {
    return res
      .status(400)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Υπάρχει ήδη κατηγορία με αυτό το id ή slug.'
        })
      );
  }

  const translatedName = buildTranslatableFromBody(req.body, 'name', name || '');
  const translatedShortDescription = buildTranslatableFromBody(req.body, 'shortDescription', undefined);
  const newCat = { id: normalizedId, name: translatedName, slug: normalizedSlug };
  if (translatedShortDescription) newCat.shortDescription = translatedShortDescription;
  if (image && image.trim()) newCat.image = image.trim();
  if (parentId && parentId.trim()) newCat.parentId = parentId.trim();
  newCat.showInMainNav = showInMainNav === 'on';
  if (navOrder !== undefined && navOrder !== '') newCat.navOrder = Number(navOrder) || 0;
  categories.push(newCat);
  saveTenantCategories(req, categories);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Η κατηγορία προστέθηκε.' })
  );
});

app.post('/admin/categories/update', async (req, res) => {
  const { password, categoryId, name, slug, parentId, image, showInMainNav, navOrder } = req.body;
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

  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
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

  const normalizedSlug = normalizeSlug(slug || categories[idx].slug);
  if (!normalizedSlug || !isUrlSafeSlug(normalizedSlug)) {
    return res
      .status(400)
      .render('admin', buildAdminViewModel(req, { error: 'Το slug πρέπει να είναι URL-safe (πεζά, αριθμοί και παύλες).' }));
  }

  if (categories.some((c) => c.id !== categoryId && c.slug === normalizedSlug)) {
    return res
      .status(400)
      .render(
        'admin',
        buildAdminViewModel(req, {
          error: 'Το slug χρησιμοποιείται ήδη από άλλη κατηγορία.'
        })
      );
  }

  if (isEukolakisClassicPreset(req) && EUKOLAKIS_CORE_CATEGORY_IDS.has(categoryId)) {
    if (normalizedSlug !== categories[idx].slug) {
      return res
        .status(400)
        .render(
          'admin',
          buildAdminViewModel(req, {
            error: 'Στο preset eukolakis_classic_diy δεν επιτρέπεται αλλαγή slug για τις βασικές κατηγορίες diy-rolla, diy-sliding, spare-parts.'
          })
        );
    }
  }

  categories[idx].name = buildTranslatableFromBody(req.body, 'name', name || categories[idx].name);
  const shortDescription = buildTranslatableFromBody(req.body, 'shortDescription', categories[idx].shortDescription);
  if (shortDescription) categories[idx].shortDescription = shortDescription;
  else delete categories[idx].shortDescription;
  categories[idx].slug = normalizedSlug;
  if (image !== undefined) {
    if (image && image.trim()) categories[idx].image = image.trim();
    else delete categories[idx].image;
  }
  if (parentId !== undefined) {
    if (parentId && parentId.trim() && parentId.trim() !== categoryId) {
      categories[idx].parentId = parentId.trim();
    } else {
      delete categories[idx].parentId;
    }
  }
  categories[idx].showInMainNav = showInMainNav === 'on';
  if (navOrder !== undefined && navOrder !== '') categories[idx].navOrder = Number(navOrder) || 0;
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

  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
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
app.get('/admin/products/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const products = loadTenantProducts(req);
  const out = products
    .filter((p) => {
      if (!q) return true;
      const pName = resolveTranslatable(p.name, DEFAULT_CONTENT_LANG).toLowerCase();
      return p.id.toLowerCase().includes(q) || pName.includes(q) || String(p.categoryId || '').toLowerCase().includes(q);
    })
    .slice(0, 30)
    .map((p) => ({
      id: p.id,
      name: resolveTranslatable(p.name, DEFAULT_CONTENT_LANG),
      imageUrl: p.imageUrl || '',
      price: Number(p.price) || 0,
      stock: Number(p.stock) || 0,
      categoryId: p.categoryId || ''
    }));
  res.json(out);
});

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

  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
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
    const storeName = resolveTranslatable(config.storeName, DEFAULT_CONTENT_LANG) || '';
    parsed.forEach((p) => {
      const localizedName = resolveTranslatable(p.name, DEFAULT_CONTENT_LANG);
      const localizedDescription = resolveTranslatable(p.description, DEFAULT_CONTENT_LANG);
      if (!p.seoTitle) {
        const catObj = categories.find((c) => c.id === p.categoryId);
        const catName = catObj ? resolveTranslatable(catObj.name, DEFAULT_CONTENT_LANG) : '';
        p.seoTitle = [localizedName, catName, storeName].filter(Boolean).join(' | ');
      }
      if (!p.seoDescription) {
        const desc = (localizedDescription || '').trim();
        p.seoDescription = desc.length > 160 ? desc.slice(0, 157) + '…' : desc || p.seoTitle;
      }
      if (!Array.isArray(p.gallery)) p.gallery = [];
    });
    saveTenantProducts(req, parsed);
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
  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
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
  saveTenantProducts(req, products);

  const stockLog = loadJson(req.tenantPaths.stockLog, []);
  stockLog.push({
    id:          Date.now().toString(36),
    productId,
    productName: resolveTranslatable(products[pIdx].name, DEFAULT_CONTENT_LANG),
    delta,
    reason:      reason || 'manual',
    orderId:     null,
    createdAt:   new Date().toISOString()
  });
  saveJson(req.tenantPaths.stockLog, stockLog);

  const pName = resolveTranslatable(products[pIdx].name, DEFAULT_CONTENT_LANG);
  res.render('admin', buildAdminViewModel(req, { message: `Απόθεμα "${pName}" ενημερώθηκε σε ${qty}.` }));
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
    const auth = await verifyAdminAction(req, password);
    if (!auth.ok) {
      return res.status(401).json({ ok: false, error: 'Invalid admin password.' });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    }

    const url = `/tenants/${req.tenant.id}/media/${req.file.filename}`;
    return res.json({ ok: true, url });
  }
);

app.post(
  '/admin/parts/image-upload',
  partsUpload.single('image'),
  async (req, res) => {
    const permissions = getSupportPermissions(req.tenant.supportTier);
    if (!permissions.canUploadMedia || !permissions.canEditProducts) {
      return res.status(403).json({ ok: false, error: 'Upload not allowed for this support tier.' });
    }
    const auth = await verifyAdminAction(req, req.body.password);
    if (!auth.ok) return res.status(401).json({ ok: false, error: 'Session expired. Please enter admin password.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    const url = `/tenants/${req.tenant.id}/media/parts/${req.file.filename}`;
    return res.json({ ok: true, url });
  }
);

app.post('/admin/categories/image-upload', categoryUpload.single('image'), async (req, res) => {
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditCategories || !permissions.canUploadMedia) {
    return res.status(403).json({ ok: false, error: 'Η ενέργεια δεν επιτρέπεται για το πακέτο σας.' });
  }
  const auth = await verifyAdminAction(req, req.body.password);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Session expired. Please enter admin password.' });
  const categoryId = String(req.body.categoryId || '').trim();
  if (!categoryId) return res.status(400).json({ ok: false, error: 'categoryId required' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
  const categories = loadTenantCategories(req);
  const idx = categories.findIndex((c) => c.id === categoryId);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Category not found' });
  const previousImage = typeof categories[idx].image === 'string' ? categories[idx].image : '';
  const tenantMediaPrefix = `/tenants/${req.tenant.id}/media/categories/`;
  if (previousImage.startsWith(tenantMediaPrefix)) {
    const oldFile = path.join(req.tenantPaths.media, 'categories', path.basename(previousImage));
    if (fs.existsSync(oldFile)) {
      try { fs.unlinkSync(oldFile); } catch (_) {}
    }
  }
  categories[idx].image = `/tenants/${req.tenant.id}/media/categories/${req.file.filename}`;
  saveTenantCategories(req, categories);
  return res.json({ ok: true, image: categories[idx].image });
});

app.post('/admin/categories/image-remove', async (req, res) => {
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditCategories) {
    return res.status(403).json({ ok: false, error: 'Η ενέργεια δεν επιτρέπεται για το πακέτο σας.' });
  }
  const auth = await verifyAdminAction(req, req.body.password);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Session expired. Please enter admin password.' });
  const categoryId = String(req.body.categoryId || '').trim();
  const categories = loadTenantCategories(req);
  const idx = categories.findIndex((c) => c.id === categoryId);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Category not found' });
  const existingImage = typeof categories[idx].image === 'string' ? categories[idx].image : '';
  const tenantMediaPrefix = `/tenants/${req.tenant.id}/media/categories/`;
  if (existingImage.startsWith(tenantMediaPrefix)) {
    const oldFile = path.join(req.tenantPaths.media, 'categories', path.basename(existingImage));
    if (fs.existsSync(oldFile)) {
      try { fs.unlinkSync(oldFile); } catch (_) {}
    }
  }
  delete categories[idx].image;
  saveTenantCategories(req, categories);
  return res.json({ ok: true });
});

// Favicon upload
app.post(
  '/admin/favicon',
  favUpload.single('favicon'),
  async (req, res) => {
    const password = req.body.password;
    const auth = await verifyAdminAction(req, password);
    if (!auth.ok) {
      return res.redirect(`${buildTenantLink(req, '/admin', { error: 'Λάθος κωδικός διαχειριστή' })}#tab-upload`);
    }
    if (!req.file) {
      return res.redirect(`${buildTenantLink(req, '/admin', { error: 'Δεν επιλέχθηκε αρχείο' })}#tab-upload`);
    }
    fs.writeFileSync(req.tenantPaths.favicon, req.file.buffer);
    return res.redirect(`${buildTenantLink(req, '/admin', { message: 'Favicon αποθηκεύτηκε' })}#tab-upload`);
  }
);

// Favicon delete
app.post('/admin/favicon/delete', async (req, res) => {
  const auth = await verifyAdminAction(req, req.body.password);
  if (!auth.ok) {
    return res.redirect(`${buildTenantLink(req, '/admin', { error: 'Λάθος κωδικός διαχειριστή' })}#tab-upload`);
  }
  if (fs.existsSync(req.tenantPaths.favicon)) {
    fs.unlinkSync(req.tenantPaths.favicon);
  }
  return res.redirect(`${buildTenantLink(req, '/admin', { message: 'Favicon διαγράφηκε' })}#tab-upload`);
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
    const auth = await verifyAdminAction(req, req.body.password);
    if (!auth.ok) return res.status(401).json({ ok: false, error: 'Invalid password.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file.' });
    const url = `/tenants/${req.tenant.id}/media/${req.file.filename}`;
    res.json({ ok: true, url, filename: req.file.filename });
  }
);

// ── Digital content: gated access page ───────────────────────────────────────
app.get('/content/:orderId', requireUser, (req, res) => {
  const orders = loadTenantOrders(req);
  const order  = orders.find((o) => o.id === req.params.orderId);
  if (!order) return res.status(404).send('Η παραγγελία δεν βρέθηκε.');
  if (normalizeEmail(order.userEmail) !== normalizeEmail(req.session.user.email)) {
    return res.status(403).send('Δεν έχετε πρόσβαση σε αυτό το περιεχόμενο.');
  }

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
      id:          'MANAGEMENT_START',
      title:       'Management Start',
      price:       49,
      priceNote:   '/ μήνα',
      description: 'Ιδανικό για μικρά brands που θέλουν managed e-shop, χωρίς WordPress / WooCommerce.',
      features: [
        'Στήσιμο e-shop πάνω στο Thronos Commerce',
        'Θεματολογία & λογότυπο',
        'Admin panel για προϊόντα, κατηγορίες & παραγγελίες',
        'Σύνδεση με domain & επαγγελματικό email',
        'Παραλλαγές προϊόντων & πλήρης κατάλογος',
        'Αξιολογήσεις επαληθευμένων αγοραστών'
      ]
    },
    {
      id:          'FULL_OPS_START',
      title:       'Full Ops',
      price:       149,
      priceNote:   '/ μήνα',
      popular:     true,
      description: 'Για brands που θέλουν πλήρη διαχείριση λειτουργίας από την ομάδα Thronos.',
      features: [
        'Όλα του Management Start',
        'Πλήρης διαχείριση προϊόντων & περιεχομένου',
        'Διαχείριση παραγγελιών & επικοινωνίας πελατών',
        'Stripe online πληρωμές',
        'Analytics & αναφορές πωλήσεων',
        'Συμβουλευτικό growth roadmap'
      ]
    },
    {
      id:          'DIGITAL_STARTER',
      title:       'Digital Starter',
      price:       79,
      priceNote:   '/ μήνα',
      description: 'Για creators & DIY brands που πουλούν digital προϊόντα: εγχειρίδια, βίντεο οδηγιών.',
      features: [
        'Όλα του Management Start',
        'Ανέβασμα PDF εγχειριδίων ανά προϊόν (έως 50 MB)',
        'Ενσωμάτωση βίντεο οδηγιών (YouTube / Vimeo / MP4)',
        'Gated content page για αγοραστές',
        'Αυτόματος σύνδεσμος πρόσβασης στο email επιβεβαίωσης',
        'Παραλλαγές kit με διαφορετικό περιεχόμενο'
      ]
    },
    {
      id:          'DIGITAL_PRO',
      title:       'Digital Pro',
      price:       199,
      priceNote:   '/ μήνα',
      description: 'Πλήρες πακέτο για digital-first επιχειρήσεις με πολλαπλά προϊόντα και ανεπτυγμένο περιεχόμενο.',
      features: [
        'Όλα του Digital Starter',
        'Πλήρης διαχείριση περιεχομένου από την ομάδα Thronos',
        'Unlimited εγχειρίδια & βίντεο ανά προϊόν',
        'Stripe online πληρωμές',
        'Analytics πρόσβασης περιεχομένου',
        'Προτεραιότητα support 7/7'
      ]
    }
  ];
}

// Thronos Commerce marketing landing
app.get('/thronos-commerce', (req, res) => {
  res.render('landing', { packages: getLandingPackages(), message: null, previewTenants: loadTenantsRegistry().map((t) => t.id) });
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
    message: 'Ευχαριστούμε! Θα επικοινωνήσουμε μαζί σας σύντομα.',
    previewTenants: loadTenantsRegistry().map((t) => t.id)
  });
});

// ── Platform Stripe: buy a Thronos Commerce subscription ─────────────────────
const PENDING_SUBS_FILE = path.join(DATA_ROOT, 'pending_subscriptions.json');

app.post('/thronos-commerce/subscribe', async (req, res) => {
  const { name, email, phone, brand, domain, packageId } = req.body;
  const pkg = getLandingPackages().find((p) => p.id === packageId);
  if (!pkg) return res.redirect('/thronos-commerce#pricing');

  // Save lead regardless
  const leadsFile = path.join(DATA_ROOT, 'leads.json');
  const leads = loadJson(leadsFile, []);
  const leadData = { id: `lead_${Date.now()}`, createdAt: new Date().toISOString(), name, email, phone, brand, domain, packageId, source: 'stripe_buy' };
  leads.push(leadData);
  saveJson(leadsFile, leads);

  const stripe = platformStripe();
  if (!stripe) {
    // No platform Stripe configured – fall back to lead-only flow
    return res.render('landing', { packages: getLandingPackages(), message: 'Ευχαριστούμε! Θα επικοινωνήσουμε μαζί σας σύντομα.', previewTenants: loadTenantsRegistry().map((t) => t.id) });
  }

  const pendingId = `psub_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const pending   = loadJson(PENDING_SUBS_FILE, {});
  pending[pendingId] = { ...leadData, pendingId };
  saveJson(PENDING_SUBS_FILE, pending);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      customer_email:       email,
      line_items: [{
        price_data: {
          currency:     'eur',
          product_data: { name: `Thronos Commerce — ${pkg.title}`, description: `Πρώτος μήνας συνδρομής` },
          unit_amount:  pkg.price * 100
        },
        quantity: 1
      }],
      success_url: `${baseUrl}/thronos-commerce/stripe-success?pending_id=${pendingId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/thronos-commerce#pricing`,
      metadata:    { pendingId, packageId, brand: brand || '' }
    });
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('[Platform Stripe] session create failed:', err.message);
    return res.render('landing', { packages: getLandingPackages(), message: 'Ευχαριστούμε! Θα επικοινωνήσουμε μαζί σας σύντομα.', previewTenants: loadTenantsRegistry().map((t) => t.id) });
  }
});

app.get('/thronos-commerce/stripe-success', async (req, res) => {
  const { pending_id, session_id } = req.query;
  const stripe = platformStripe();

  const pending = loadJson(PENDING_SUBS_FILE, {});
  const entry   = pending[pending_id];

  if (stripe && session_id && entry) {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.payment_status === 'paid') {
        entry.paid      = true;
        entry.paidAt    = new Date().toISOString();
        entry.sessionId = session_id;
        delete pending[pending_id];
        saveJson(PENDING_SUBS_FILE, pending);
        // Save as paid lead
        const paidLeadsFile = path.join(DATA_ROOT, 'paid_leads.json');
        const paidLeads = loadJson(paidLeadsFile, []);
        paidLeads.push(entry);
        saveJson(paidLeadsFile, paidLeads);
        // Notify Thronos team via email
        const pkg = getLandingPackages().find((p) => p.id === entry.packageId);
        const amount = pkg ? `${pkg.price} €` : '–';
        if (nodemailer) {
          try {
            const smtpUser = process.env.THRC_MAIL_SMTP_USER;
            const smtpPass = process.env.THRC_MAIL_SMTP_PASS;
            if (smtpUser && smtpPass) {
              const transporter = nodemailer.createTransport({ host: process.env.THRC_MAIL_SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.THRC_MAIL_SMTP_PORT || 587), secure: false, auth: { user: smtpUser, pass: smtpPass } });
              await transporter.sendMail({
                from: smtpUser,
                to: 'support@thronoschain.org',
                subject: `💳 Νέα πληρωμένη συνδρομή — ${entry.brand} (${entry.packageId})`,
                text: `Νέος πελάτης πλήρωσε:\n\nΌνομα: ${entry.name}\nEmail: ${entry.email}\nΤηλ: ${entry.phone}\nBrand: ${entry.brand}\nDomain: ${entry.domain || '–'}\nΠακέτο: ${entry.packageId} — ${amount}\nSession: ${session_id}\n\nΕνεργοποιήστε τον tenant στον root admin.`
              });
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  res.render('landing', {
    packages: getLandingPackages(),
    message: `✓ Η πληρωμή ολοκληρώθηκε! Η ομάδα Thronos θα επικοινωνήσει μαζί σας εντός 24 ωρών για την ενεργοποίηση του καταστήματός σας.`,
    previewTenants: loadTenantsRegistry().map((t) => t.id)
  });
});

// ── Tenant subscription renewal (from admin dashboard) ────────────────────────
app.post('/admin/subscribe/renew', async (req, res) => {
  const { password } = req.body;
  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) return res.render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός.' }));

  const stripe = platformStripe();
  if (!stripe) return res.render('admin', buildAdminViewModel(req, { error: 'Η πλατφόρμα δεν έχει ρυθμιστεί για online πληρωμές ακόμα. Επικοινωνήστε μαζί μας.' }));

  const tenantRec = findTenantById(req.tenant.id);
  const plan      = (tenantRec && tenantRec.subscriptionPlan) || tenantRec?.supportTier || 'MANAGEMENT_START';
  const price     = PACKAGE_PRICES[plan] || 49;
  const pkg       = getLandingPackages().find((p) => p.id === plan);

  const pendingId = `pren_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const pending   = loadJson(PENDING_SUBS_FILE, {});
  pending[pendingId] = { tenantId: req.tenant.id, plan, price, pendingId };
  saveJson(PENDING_SUBS_FILE, pending);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      customer_email:       req.body.email || undefined,
      line_items: [{
        price_data: {
          currency:     'eur',
          product_data: { name: `Ανανέωση συνδρομής — ${pkg ? pkg.title : plan}` },
          unit_amount:  price * 100
        },
        quantity: 1
      }],
      success_url: `${baseUrl}/admin/subscribe/success?pending_id=${pendingId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/admin`
    });
    return res.redirect(303, session.url);
  } catch (err) {
    return res.render('admin', buildAdminViewModel(req, { error: 'Σφάλμα σύνδεσης με Stripe: ' + err.message }));
  }
});

app.get('/admin/subscribe/success', async (req, res) => {
  const { pending_id, session_id } = req.query;
  const stripe = platformStripe();

  const pending = loadJson(PENDING_SUBS_FILE, {});
  const entry   = pending[pending_id];

  if (stripe && session_id && entry && entry.tenantId === req.tenant.id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.payment_status === 'paid') {
        // Extend subscription by 30 days from now (or from current expiry if still active)
        const tenants = loadTenantsRegistry();
        const idx     = tenants.findIndex((t) => t.id === req.tenant.id);
        if (idx >= 0) {
          const current   = tenants[idx].subscriptionExpiry ? new Date(tenants[idx].subscriptionExpiry) : new Date();
          const base      = current > new Date() ? current : new Date();
          base.setDate(base.getDate() + 30);
          tenants[idx].subscriptionExpiry   = base.toISOString();
          tenants[idx].subscriptionPlan     = entry.plan;
          tenants[idx].subscriptionStatus   = 'active';
          saveTenantsRegistry(tenants);
        }
        delete pending[pending_id];
        saveJson(PENDING_SUBS_FILE, pending);
      }
    } catch (_) {}
  }

  res.render('admin', buildAdminViewModel(req, { message: '✓ Η ανανέωση συνδρομής ολοκληρώθηκε.' }));
});

// ── Ticket system ─────────────────────────────────────────────────────────────
app.post('/admin/tickets/new', async (req, res) => {
  const { password, subject, message: body, category } = req.body;
  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) return res.render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός.' }));
  if (!subject || !body) return res.render('admin', buildAdminViewModel(req, { error: 'Συμπληρώστε θέμα και μήνυμα.' }));

  const ticket = {
    id:        `tkt_${Date.now()}`,
    tenantId:  req.tenant.id,
    subject:   subject.trim(),
    body:      body.trim(),
    category:  category || 'general',
    status:    'open',
    createdAt: new Date().toISOString(),
    replies:   []
  };

  const tickets = loadJson(req.tenantPaths.tickets, []);
  tickets.push(ticket);
  saveJson(req.tenantPaths.tickets, tickets);

  // Email to support
  if (nodemailer) {
    try {
      const smtpUser = process.env.THRC_MAIL_SMTP_USER;
      const smtpPass = process.env.THRC_MAIL_SMTP_PASS;
      if (smtpUser && smtpPass) {
        const transporter = nodemailer.createTransport({ host: process.env.THRC_MAIL_SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.THRC_MAIL_SMTP_PORT || 587), secure: false, auth: { user: smtpUser, pass: smtpPass } });
        const config = loadTenantConfig(req);
        await transporter.sendMail({
          from:    smtpUser,
          to:      'support@thronoschain.org',
          subject: `[Ticket #${ticket.id}] [${req.tenant.id}] ${ticket.subject}`,
          text:    `Tenant: ${req.tenant.id} (${resolveTranslatable(config.storeName, DEFAULT_CONTENT_LANG) || ''})\nΚατηγορία: ${ticket.category}\n\n${ticket.body}\n\n---\nΑπαντήστε σε αυτό το email για να απαντήσετε στον tenant.`
        });
      }
    } catch (_) {}
  }

  res.render('admin', buildAdminViewModel(req, { message: '✓ Το αίτημα υποστήριξης στάλθηκε. Θα επικοινωνήσουμε σύντομα.' }));
});

// Root admin: add reply to ticket
app.post('/root/tickets/reply', async (req, res) => {
  const { password, tenantId, ticketId, replyText } = req.body;
  if (!verifyRootPassword(password)) return res.redirect('/root/tenants?error=wrong_password');

  const tenantPaths = tenantPaths(tenantId);
  const tickets = loadJson(tenantPaths.tickets, []);
  const tIdx    = tickets.findIndex((t) => t.id === ticketId);
  if (tIdx >= 0) {
    tickets[tIdx].replies.push({ from: 'support', text: replyText.trim(), createdAt: new Date().toISOString() });
    tickets[tIdx].status = 'replied';
    saveJson(tenantPaths.tickets, tickets);
  }

  res.redirect('/root/tenants?message=reply_sent');
});

// Root admin: close ticket
app.post('/root/tickets/close', async (req, res) => {
  const { password, tenantId, ticketId } = req.body;
  if (!verifyRootPassword(password)) return res.redirect('/root/tenants?error=wrong_password');

  const tenantPaths = tenantPaths(tenantId);
  const tickets = loadJson(tenantPaths.tickets, []);
  const tIdx    = tickets.findIndex((t) => t.id === ticketId);
  if (tIdx >= 0) { tickets[tIdx].status = 'resolved'; saveJson(tenantPaths.tickets, tickets); }
  res.redirect('/root/tenants');
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

  // Collect all open tickets across tenants for root admin
  const allTickets = [];
  tenants.forEach((t) => {
    try {
      const tks = loadJson(tenantPaths(t.id).tickets, []);
      tks.filter((tk) => tk.status !== 'resolved').forEach((tk) => {
        allTickets.push({ ...tk, _tenantId: t.id });
      });
    } catch (_) {}
  });

  return {
    tenants,
    themeTemplates: listThemeTemplates(),
    tenantPaymentConfigs,
    refAccounts,
    refEarnings: refEarnings.slice(-200).reverse(),
    pendingByCode,
    allTickets: allTickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    getSubscriptionInfo,
    PACKAGE_PRICES,
    message: null,
    error: null,
    ...(extra || {})
  };
}

app.get('/root/tenants', (req, res) => {
  res.render('root-tenants', buildRootViewModel());
});

app.get('/root/login', (req, res) => {
  if (req.session.rootAdmin) return res.redirect('/root/tenants');
  res.render('root-login', { error: null });
});

app.post('/root/login', (req, res) => {
  const { password } = req.body;
  if (!verifyRootPassword(password)) {
    return res.status(401).render('root-login', { error: 'Invalid root password.' });
  }
  req.session.rootAdmin = { authenticatedAt: new Date().toISOString() };
  res.redirect('/root/tenants');
});

app.get('/root/logout', (req, res) => {
  req.session.rootAdmin = null;
  res.redirect('/root/login');
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

app.post('/root/templates/create', (req, res) => {
  const { rootPassword, tenantId, templateId, templateName } = req.body;
  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants', buildRootViewModel({ error: 'Λάθος root κωδικός.' }));
  }
  const tenant = findTenantById((tenantId || '').trim());
  if (!tenant) {
    return res.status(404).render('root-tenants', buildRootViewModel({ error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }
  const cleanTemplateId = sanitizeTemplateId(templateId);
  if (!cleanTemplateId) {
    return res.status(400).render('root-tenants', buildRootViewModel({ error: 'Δώστε έγκυρο template id (a-z, 0-9, -, _).' }));
  }
  const tpl = saveTemplateFromTenant(cleanTemplateId, tenant.id, templateName);
  return res.render('root-tenants', buildRootViewModel({ message: `Template "${tpl.id}" αποθηκεύτηκε.` }));
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

  const { subscriptionExpiry } = req.body;
  if (subscriptionExpiry) {
    const expDate = new Date(subscriptionExpiry);
    if (!isNaN(expDate)) {
      tenants[idx].subscriptionExpiry = expDate.toISOString();
      tenants[idx].subscriptionPlan   = tenants[idx].subscriptionPlan || tenants[idx].supportTier;
      tenants[idx].subscriptionStatus = 'active';
    }
  }

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
    // In production, webhook secret is required — reject unverified events
    if (process.env.NODE_ENV === 'production') {
      console.error('[Stripe Webhook] STRIPE_WEBHOOK_SECRET not configured — rejecting unverified event');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    // Dev/testing only — accept raw JSON
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
