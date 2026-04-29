process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

const express = require('express');
const { normalizeAssistantConfig } = require('./lib/assistant-config');
const setupAdminAssistantRoutes = require('./lib/admin-assistant-routes');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const crypto = require('crypto');
const axios = require('axios');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { normalizeHost, resolveTenantFromHost, tenantHostnames } = require('./utils/tenant-host-resolver');
const { runDomainCheck, runDomainCheckFull } = require('./utils/dns-check');
const { getCloudflareClient, getTenantZoneId } = require('./utils/cloudflare-api');
const RailwayRegistry = require('./utils/railway-registry');

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
  const fallback = {
    plan: (tenant && (tenant.subscriptionPlan || tenant.supportTier)) || 'SELF_SERVICE',
    status: 'manual',
    daysLeft: null,
    isExpired: false,
    isExpiringSoon: false,
    expiryStr: null
  };
  if (!tenant || typeof tenant !== 'object') {
    console.log('[root-admin] subscription-fallback', JSON.stringify({ reason: 'missing_tenant' }));
    return fallback;
  }
  if (!tenant.subscriptionExpiry) {
    console.log('[root-admin] subscription-fallback', JSON.stringify({
      reason: 'missing_subscription_expiry',
      tenantId: tenant.id || null
    }));
    return fallback;
  }
  const expiry = new Date(tenant.subscriptionExpiry);
  if (Number.isNaN(expiry.getTime())) {
    console.log('[root-admin] subscription-fallback', JSON.stringify({
      reason: 'invalid_subscription_expiry',
      tenantId: tenant.id || null,
      rawValue: tenant.subscriptionExpiry
    }));
    return fallback;
  }
  const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
  const daysOverdue = daysLeft < 0 ? Math.abs(daysLeft) : 0;
  return {
    plan: tenant.subscriptionPlan || tenant.supportTier || 'SELF_SERVICE',
    status: daysLeft <= 0 ? 'expired' : 'active',
    expiryStr: expiry.toLocaleDateString('el-GR'),
    daysLeft: Math.max(0, daysLeft),
    daysOverdue,
    isExpired: daysLeft <= 0,
    isExpiringSoon: daysLeft > 0 && daysLeft <= 5,
    isInGrace: daysLeft <= 0 && daysOverdue < 10,
    isGraceExpired: daysOverdue >= 10
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

function normalizeMediaPath(value, options = {}) {
  const allowAbsoluteUrl = options.allowAbsoluteUrl === true;
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (allowAbsoluteUrl && /^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return raw;
  return `/${raw.replace(/^\.?\//, '')}`;
}

function normalizeCategoryRecord(rawCategory, index = 0) {
  const source = rawCategory && typeof rawCategory === 'object' ? rawCategory : {};
  const safeId = normalizeSlug(source.id || source.slug || `category-${index + 1}`) || `category-${index + 1}`;
  const safeSlug = normalizeSlug(source.slug || safeId) || safeId;
  const fallbackName = safeSlug.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  const normalizedName = source.name && (typeof source.name === 'string' || typeof source.name === 'object')
    ? source.name
    : fallbackName;
  const navVisibilityRaw = source.showInMainNav;
  const normalizedShowInMainNav = navVisibilityRaw !== undefined
    ? navVisibilityRaw !== false
    : (source.visible !== false && source.inMainNav !== false);
  const rawOrder = source.navOrder !== undefined ? source.navOrder : source.order;
  const navOrder = Number.isFinite(Number(rawOrder)) ? Number(rawOrder) : index;
  return {
    ...source,
    id: safeId,
    slug: safeSlug,
    name: normalizedName,
    image: normalizeMediaPath(source.image),
    featured: source.featured === true,
    showInMainNav: normalizedShowInMainNav,
    navOrder
  };
}

function isUrlSafeSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || ''));
}

function isEukolakisClassicPreset(req) {
  if (!req || !req.tenant) return false;
  const config = loadTenantConfig(req);
  const presetId = config && config.theme && config.theme.presetId;
  return presetId === 'eukolakis_classic_diy';
}

function detectDeviceInfo(req) {
  const ua = String((req && req.headers && req.headers['user-agent']) || '').toLowerCase();
  const os = /iphone|ipad|ipod/.test(ua) ? 'ios' : (/android/.test(ua) ? 'android' : 'other');
  let device = 'desktop';
  if (/ipad|tablet/.test(ua) || (/android/.test(ua) && !/mobile/.test(ua))) device = 'tablet';
  else if (/mobile|iphone|ipod/.test(ua) || (/android/.test(ua) && /mobile/.test(ua))) device = 'mobile';
  return { device, os };
}
function readCheckbox(body, key, currentValue) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, key)) return currentValue;
  let raw = body[key];
  if (Array.isArray(raw)) raw = raw[raw.length - 1];
  const normalized = String(raw || '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(normalized);
}
function hasBodyField(body, key) {
  return !!body && Object.prototype.hasOwnProperty.call(body, key);
}

const EUKOLAKIS_CORE_CATEGORY_IDS = new Set(['diy-rolla', 'diy-sliding', 'spare-parts']);
function shouldDefaultPartsOnly(tenant, config) {
  return !!(config && config.theme && config.theme.presetId === 'eukolakis_classic_diy');
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
      const fixedVariantId = typeof choice.linkedVariantId === 'string' ? choice.linkedVariantId.trim() : '';
      const linkedVariant = fixedVariantId
        ? linkedVariants.find((variant) => variant.id === fixedVariantId)
        : null;
      const effectiveLinkedPrice = linkedVariant && linkedVariant.price !== undefined && !Number.isNaN(Number(linkedVariant.price))
        ? Number(linkedVariant.price)
        : linkedPrice;
      const effectiveLinkedImageUrl = (linkedVariant && linkedVariant.imageUrl) || (linked && linked.imageUrl ? linked.imageUrl : '');
      const isSkipChoice = choice.id === 'skip';
      const computedPriceDelta = kitPayMode === 'parts_only'
        ? (isSkipChoice ? 0 : effectiveLinkedPrice)
        : (choice.useLinkedPriceDelta && linked ? effectiveLinkedPrice : (Number(choice.priceDelta) || 0));
      return {
        ...choice,
        label: (choice.label || '').trim() || linkedName || choice.id,
        description: (choice.description || '').trim() || (linkedDescription ? linkedDescription.slice(0, 140) : ''),
        image: (choice.image || '').trim() || effectiveLinkedImageUrl,
        priceDelta: computedPriceDelta,
        linkedPrice: effectiveLinkedPrice,
        linkedName: linkedName || '',
        linkedImageUrl: effectiveLinkedImageUrl,
        linkedVariants,
        linkedVariantId: linkedVariant ? linkedVariant.id : '',
        linkedVariant: linkedVariant || undefined
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
const REFERRAL_LEDGER_FILE   = path.join(DATA_ROOT, 'referral_ledger.json');
const SETTLEMENT_LEDGER_FILE = path.join(DATA_ROOT, 'settlement_ledger.json');
const THEME_GOVERNANCE_FILE  = path.join(DATA_ROOT, 'theme-governance.json');
const RAILWAY_REGISTRY_FILE  = path.join(DATA_ROOT, 'railway-registry.json');

let railwayRegistry = null;

const THEME_CATALOG = Object.freeze({
  core_default: {
    key: 'core_default',
    label: 'Core Default',
    description: 'General storefront theme for most tenants.',
    supportedSettings: ['colors', 'menu', 'layout', 'logo', 'productCards', 'homepage', 'cursor']
  },
  eukolakis_classic_diy: {
    key: 'eukolakis_classic_diy',
    label: 'Eukolakis Classic DIY',
    description: 'Industrial DIY storefront with specialized hero/nav/product behavior.',
    supportedSettings: ['logo', 'productCards', 'homepage', 'diy']
  }
});
const DEFAULT_THEME_KEY = 'core_default';
const DEFAULT_AVAILABLE_THEME_KEYS = Object.freeze([DEFAULT_THEME_KEY, 'eukolakis_classic_diy']);

function loadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    console.warn(`Could not load ${filePath}: ${err.message}`);
    return fallback;
  }
}

function saveJson(filePath, data) {
  // Atomic write: write to a temp file then rename so a crash during write
  // never produces a partially-written file.
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function listThemeCatalog() {
  return Object.values(THEME_CATALOG);
}

function normalizeThemeKeys(keys, fallback = [DEFAULT_THEME_KEY]) {
  const source = Array.isArray(keys) ? keys : [];
  const normalized = [];
  source.forEach((value) => {
    const key = String(value || '').trim();
    if (!key || !THEME_CATALOG[key]) return;
    if (!normalized.includes(key)) normalized.push(key);
  });
  if (!normalized.length) {
    const fallbackKeys = Array.isArray(fallback) ? fallback : [DEFAULT_THEME_KEY];
    fallbackKeys.forEach((value) => {
      const key = String(value || '').trim();
      if (THEME_CATALOG[key] && !normalized.includes(key)) normalized.push(key);
    });
  }
  if (!normalized.length) normalized.push(DEFAULT_THEME_KEY);
  return normalized;
}

function loadThemeGovernance() {
  const raw = loadJson(THEME_GOVERNANCE_FILE, {});
  const availableThemeKeys = normalizeThemeKeys(raw && raw.availableThemeKeys, DEFAULT_AVAILABLE_THEME_KEYS);
  return { availableThemeKeys };
}

function saveThemeGovernance(next) {
  const safe = {
    availableThemeKeys: normalizeThemeKeys(next && next.availableThemeKeys, DEFAULT_AVAILABLE_THEME_KEYS)
  };
  saveJson(THEME_GOVERNANCE_FILE, safe);
}

function loadTenantsRegistry() {
  const tenants = loadJson(TENANTS_REGISTRY, []);
  if (!Array.isArray(tenants)) return [];
  const governance = loadThemeGovernance();
  return tenants.map((tenant) => {
    const hosting = tenant && tenant.hosting && typeof tenant.hosting === 'object' ? tenant.hosting : {};
    const poweredByCfg = getTenantPoweredByConfig(tenant);
    return {
      ...tenant,
      allowedThemeKeys: normalizeThemeKeys(tenant && tenant.allowedThemeKeys, governance.availableThemeKeys),
      poweredByMode: poweredByCfg.poweredByMode,
      poweredByLabel: poweredByCfg.poweredByLabel,
      poweredByHref: poweredByCfg.poweredByHref,
      allowPoweredBy: poweredByCfg.allowPoweredBy,
      hosting: {
        ...hosting,
        domainStatus: hosting.domainStatus || tenant.domainStatus || 'pending_dns',
        sslStatus: hosting.sslStatus || 'pending',
        sslProvider: hosting.sslProvider || '',
        sslValidUntil: hosting.sslValidUntil || '',
        dnsVerifiedAt: hosting.dnsVerifiedAt || '',
        lastCheckedAt: hosting.lastCheckedAt || '',
        issueFlag: hosting.issueFlag === true,
        internalNotes: hosting.internalNotes || '',
        tenantNotes: hosting.tenantNotes || '',
        storageUsageMb: Number.isFinite(Number(hosting.storageUsageMb)) ? Number(hosting.storageUsageMb) : null,
        backupStatus: hosting.backupStatus || 'unknown'
      }
    };
  });
}

function saveTenantsRegistry(tenants) {
  saveJson(TENANTS_REGISTRY, tenants);
}

function migrateToProvisioningSchema() {
  const tenants = loadJson(TENANTS_REGISTRY, []);
  if (!Array.isArray(tenants)) return;

  let changed = false;

  const migrated = tenants.map((tenant) => {
    const t = { ...tenant };

    // Initialize domainProvisioning if missing
    if (!t.domainProvisioning) {
      changed = true;
      const primaryDomain = t.primaryDomain || t.domain || '';
      const aliases = Array.isArray(t.domains) ? [...t.domains] : [];
      const legacyStatus = t.domainStatus || (t.hosting && t.hosting.domainStatus) || 'pending_dns';

      t.domainProvisioning = {
        primaryDomain: primaryDomain ? {
          domain: primaryDomain,
          status: legacyStatus,
          dnsCheckResult: null,
          railwayDeploymentId: null,
          sslCertificateId: null,
          lastUpdatedAt: new Date().toISOString()
        } : null,
        aliases: aliases.map((domain) => ({
          domain,
          status: legacyStatus,
          dnsCheckResult: null,
          railwayDeploymentId: null,
          sslCertificateId: null,
          lastUpdatedAt: new Date().toISOString()
        }))
      };
    }

    // Initialize mailHosting if missing
    if (!t.mailHosting) {
      changed = true;
      t.mailHosting = {
        mailProvider: null,
        mxRecords: [],
        spfRecord: null,
        dkimRecords: [],
        dmarcRecord: null
      };
    }

    // Initialize web3Config if missing
    if (!t.web3Config) {
      changed = true;
      t.web3Config = {
        web3Enabled: false,
        web3Host: null,
        ipfsGateway: null,
        dnslinkTxt: null
      };
    }

    return t;
  });

  if (changed) {
    console.log('[migration] Upgraded', tenants.length, 'tenant(s) to provisioning schema');
    saveTenantsRegistry(migrated);
  }
}

function normalizeTenantDomainInputs({ domain, primaryDomain, domains, previewSubdomain, fallbackPreviewSubdomain }) {
  const normalizedDomain = normalizeHost(domain || '');
  const normalizedPrimary = normalizeHost(primaryDomain || normalizedDomain);
  const parsedAliases = String(domains || '')
    .split(',')
    .map((value) => normalizeHost(value))
    .filter(Boolean);
  const dedupedAliases = [...new Set(parsedAliases)].filter((alias) => alias !== normalizedPrimary);
  const preview = String(previewSubdomain || fallbackPreviewSubdomain || '').trim().toLowerCase();
  return {
    domain: normalizedDomain,
    primaryDomain: normalizedPrimary,
    domains: dedupedAliases,
    previewSubdomain: preview
  };
}

function getAllowedThemeKeysForTenant(tenant) {
  const governance = loadThemeGovernance();
  const tenantAllowed = normalizeThemeKeys(tenant && tenant.allowedThemeKeys, governance.availableThemeKeys);
  return tenantAllowed.filter((key) => governance.availableThemeKeys.includes(key));
}

function resolveThemeKeyForTenant(tenant, requestedKey) {
  const allowed = getAllowedThemeKeysForTenant(tenant);
  const key = String(requestedKey || '').trim();
  if (key && allowed.includes(key)) return key;
  if (allowed.length) return allowed[0];
  return DEFAULT_THEME_KEY;
}

function findTenantById(tenantId) {
  return loadTenantsRegistry().find((t) => t.id === tenantId) || null;
}

function parseBooleanInput(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map(v => String(v).trim().toLowerCase());
  if (normalized.some(v => ['true', '1', 'on', 'yes'].includes(v))) return true;
  if (normalized.some(v => ['false', '0', 'off', 'no'].includes(v))) return false;
  return fallback;
}

function getTenantCanonicalConfig(tenant) {
  const t = tenant || {};
  const baseDomain = String(t.primaryDomain || t.domain || '').trim();
  const canonicalToWww = t.canonicalToWww === true;
  return {
    canonicalToWww,
    canonicalHost: canonicalToWww ? 'www' : 'apex',
    canonicalDomain: canonicalToWww ? (baseDomain ? `www.${baseDomain}` : '') : baseDomain,
    apexMode: canonicalToWww ? 'redirect_to_www' : 'direct_to_platform',
    source: 'tenant.canonicalToWww'
  };
}

function getTenantPoweredByConfig(tenant) {
  const t = tenant || {};
  const mode = ['always', 'free_only', 'disabled'].includes(String(t.poweredByMode || '').trim())
    ? String(t.poweredByMode).trim()
    : (t.allowPoweredBy === true ? 'always' : 'disabled');
  return {
    poweredByMode: mode,
    poweredByLabel: String(t.poweredByLabel || '').trim(),
    poweredByHref: String(t.poweredByHref || '').trim(),
    allowPoweredBy: mode !== 'disabled'
  };
}

function getTenantHostingSnapshot(tenant, req) {
  const t = tenant || {};
  const hosting = t.hosting || {};
  const canonicalCfg = getTenantCanonicalConfig(t);
  const poweredByCfg = getTenantPoweredByConfig(t);
  const aliases = Array.isArray(t.domains) ? t.domains : [];
  const primaryDomain = String(t.primaryDomain || t.domain || '').trim();
  const previewSubdomain = String(t.previewSubdomain || t.id || '').trim();
  const previewHost = previewSubdomain ? `${previewSubdomain}.thonoscommerce.thronoschain.org` : '';
  const config = req ? loadTenantConfig(req) : {};
  const vaAssistant = (config && config.assistant) || {};
  const vaBackendAvailable = !!(process.env.THRONOS_ASSISTANT_URL || process.env.ASSISTANT_API_URL);
  const vaEnabled = !!vaAssistant.vaEnabled;
  const vaMode = vaAssistant.vaMode || 'disabled';
  const vaWarning = vaEnabled && ['customer', 'both'].includes(vaMode) && !vaBackendAvailable
    ? 'Widget enabled but THRONOS_ASSISTANT_URL env var is not set — chat will fail.'
    : null;
  const domainType = (t.primaryDomain || t.domain) ? 'custom' : 'platform';

  // Cloudflare config: zone ID is per-tenant only; token source is env (never exposed to view)
  const cloudflareZoneId = (hosting.cloudflareZoneId || '').trim();
  const hasCloudflareZone = !!cloudflareZoneId;
  const cloudflareTokenSource = (hosting.cloudflareApiToken || '').trim()
    ? 'per-tenant' : (process.env.CLOUDFLARE_API_TOKEN ? 'env' : 'none');

  // Railway registry info for this tenant
  const railwayInfo = (typeof railwayRegistry !== 'undefined' && railwayRegistry)
    ? railwayRegistry.getForTenant(canonicalCfg.canonicalDomain || primaryDomain, aliases)
    : {};
  const sslManualOverride = (hosting && hosting.sslManualOverride && typeof hosting.sslManualOverride === 'object')
    ? hosting.sslManualOverride
    : null;

  return {
    primaryDomain,
    aliases,
    previewSubdomain,
    previewHost,
    canonicalToWww: canonicalCfg.canonicalToWww,
    canonicalHost: canonicalCfg.canonicalHost,
    canonicalDomain: canonicalCfg.canonicalDomain,
    apexMode: canonicalCfg.apexMode,
    canonicalSource: canonicalCfg.source,
    domainStatus: hosting.domainStatus || t.domainStatus || 'pending_dns',
    propagationStatus: hosting.propagationStatus || 'unknown',
    sslStatus: hosting.sslStatus || t.sslStatus || 'pending',
    sslProvider: hosting.sslProvider || 'unknown',
    sslValidUntil: hosting.sslValidUntil || '',
    sslManualOverride,
    dnsVerifiedAt: hosting.dnsVerifiedAt || '',
    lastCheckedAt: hosting.lastCheckedAt || '',
    lastCheckError: hosting.lastCheckError || '',
    aliasResults: hosting.aliasResults || [],
    issueFlag: hosting.issueFlag === true,
    internalNotes: hosting.internalNotes || '',
    tenantNotes: hosting.tenantNotes || '',
    storageUsageMb: Number.isFinite(Number(hosting.storageUsageMb)) ? Number(hosting.storageUsageMb) : null,
    backupStatus: hosting.backupStatus || 'unknown',
    logoConfigured: !!(config && config.logoPath),
    faviconConfigured: !!(config && config.favicon && config.favicon.path),
    introConfigured: !!(config && config.homepage && config.homepage.introEnabled),
    introAssetConfigured: !!(config && config.homepage && (config.homepage.introVideoUrl || config.homepage.introPosterUrl)),
    dnsCheckResult: hosting.dnsCheckResult || null,
    domainType,
    vaEnabled,
    vaMode,
    vaBackendAvailable,
    vaWarning,
    poweredByMode: poweredByCfg.poweredByMode,
    poweredByLabel: poweredByCfg.poweredByLabel,
    poweredByHref: poweredByCfg.poweredByHref,
    allowPoweredBy: poweredByCfg.allowPoweredBy,
    cloudflareZoneId,
    hasCloudflareZone,
    cloudflareTokenSource,
    railwayInfo
  };
}

function applyTenantCloudflareConfig(tenant, { cfZoneId, cfApiToken, clearTokenOverride }) {
  const nextTenant = tenant || {};
  const nextHosting = (nextTenant.hosting && typeof nextTenant.hosting === 'object')
    ? { ...nextTenant.hosting }
    : {};

  const cleanZoneId = String(cfZoneId || '').trim();
  const cleanToken = String(cfApiToken || '').trim();
  const shouldClearToken = clearTokenOverride === true
    || String(clearTokenOverride || '').trim() === '1'
    || String(clearTokenOverride || '').trim().toLowerCase() === 'true';

  if (cleanZoneId) nextHosting.cloudflareZoneId = cleanZoneId;
  if (shouldClearToken) delete nextHosting.cloudflareApiToken;
  else if (cleanToken) nextHosting.cloudflareApiToken = cleanToken;

  return { ...nextTenant, hosting: nextHosting };
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

function loadReferralLedger() {
  const rows = loadJson(REFERRAL_LEDGER_FILE, []);
  return Array.isArray(rows) ? rows : [];
}

function saveReferralLedger(rows) { saveJson(REFERRAL_LEDGER_FILE, rows); }

function loadSettlementLedger() {
  const rows = loadJson(SETTLEMENT_LEDGER_FILE, []);
  return Array.isArray(rows) ? rows : [];
}

function saveSettlementLedger(rows) { saveJson(SETTLEMENT_LEDGER_FILE, rows); }

function getTenantReferralConfig(tenant) {
  if (!tenant || typeof tenant !== 'object') return { code: '', percent: 0 };
  const ref = tenant.referral || {};
  const code = String(ref.code || tenant.refCode || '').trim();
  const rawPercent = Number(ref.percent != null ? ref.percent : tenant.refPercent);
  const percent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(0.5, rawPercent)) : 0;
  return { code, percent };
}

function buildOrderFinancialBreakdown(req, order) {
  const tenant = req.tenant || {};
  const paymentOptions = Array.isArray(order && order.paymentOptionsSnapshot) ? order.paymentOptionsSnapshot : [];
  const paymentOpt = paymentOptions.find((p) => p && (p.id === order.paymentMethodId || p.type === order.paymentMethodId)) || {};
  const gatewaySurchargeAmount = Number(order.gatewayFee || 0);
  const subtotal = Number(order.subtotalBeforeDiscount || order.subtotal || 0);
  const discount = Number(order.quantityDiscount || 0) + Number(order.couponDiscount || 0);
  const shipping = Number(order.shippingCost || 0);
  const totalCharged = Number(order.total || 0);
  const platformFeePercent = Number(tenant.platformFeePercent || 0);
  const platformFeeAmount = +(subtotal * platformFeePercent).toFixed(2);
  const referralCfg = getTenantReferralConfig(tenant);
  const commissionBase = subtotal;
  const referralCommissionAmount = referralCfg.code
    ? +(commissionBase * referralCfg.percent).toFixed(2)
    : 0;
  const tenantGrossAmount = totalCharged;
  const paymentMethod = String(order.paymentMethodId || '').toLowerCase();
  const isCOD = paymentMethod === 'cod' || String(order.paymentStatus || '').toUpperCase() === 'PENDING_COD';
  const settlementDirection = isCOD ? 'receivable_from_tenant' : 'payable_to_tenant';
  const estimatedTenantNetSettlement = isCOD
    ? +(platformFeeAmount + referralCommissionAmount).toFixed(2)
    : +(tenantGrossAmount - platformFeeAmount - referralCommissionAmount).toFixed(2);
  return {
    subtotal,
    shipping,
    discount,
    gatewaySurchargeAmount,
    totalCharged,
    paymentMethod: order.paymentMethodId || '',
    tenantGrossAmount,
    platformFeeAmount,
    referralCommissionAmount,
    estimatedTenantNetSettlement,
    settlementDirection,
    currency: String(order.currency || 'EUR').toUpperCase(),
    paymentMethodType: paymentOpt.type || paymentMethod || ''
  };
}

function createFinancialLedgerEntries(req, order) {
  if (!order || !order.id || !req || !req.tenant) return;
  const now = new Date().toISOString();
  const tenantId = req.tenant.id;
  const breakdown = buildOrderFinancialBreakdown(req, order);
  order.finance = {
    ...(order.finance || {}),
    ...breakdown,
    createdAt: order.createdAt || now,
    updatedAt: now
  };
  console.log('[finance] order-breakdown', JSON.stringify({
    tenantId,
    orderId: order.id,
    totalCharged: breakdown.totalCharged,
    settlementDirection: breakdown.settlementDirection
  }));

  const settlementLedger = loadSettlementLedger();
  const settlementExists = settlementLedger.some((r) => r && r.tenantId === tenantId && r.orderId === order.id);
  if (!settlementExists) {
    settlementLedger.push({
      id: `stl_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      tenantId,
      orderId: order.id,
      paymentMethod: breakdown.paymentMethod,
      grossAmount: breakdown.tenantGrossAmount,
      platformFeeAmount: breakdown.platformFeeAmount,
      gatewaySurchargeAmount: breakdown.gatewaySurchargeAmount,
      referralCommissionAmount: breakdown.referralCommissionAmount,
      netSettlementAmount: breakdown.estimatedTenantNetSettlement,
      settlementDirection: breakdown.settlementDirection,
      status: 'pending',
      currency: breakdown.currency,
      notes: '',
      createdAt: now,
      updatedAt: now
    });
    saveSettlementLedger(settlementLedger);
    console.log('[finance] settlement-ledger:create', JSON.stringify({ tenantId, orderId: order.id }));
  } else {
    console.log('[finance] settlement-ledger:skip', JSON.stringify({ tenantId, orderId: order.id, reason: 'already_exists' }));
  }

  const referralCfg = getTenantReferralConfig(req.tenant);
  const referralLedger = loadReferralLedger();
  const referralExists = referralLedger.some((r) => r && r.tenantId === tenantId && r.orderId === order.id);
  if (referralCfg.code && !referralExists) {
    referralLedger.push({
      id: `rfl_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      tenantId,
      orderId: order.id,
      referralCode: referralCfg.code,
      referralPercent: referralCfg.percent,
      commissionBase: breakdown.subtotal,
      commissionAmount: breakdown.referralCommissionAmount,
      paymentMethod: breakdown.paymentMethod,
      status: 'pending',
      notes: '',
      createdAt: now,
      updatedAt: now
    });
    saveReferralLedger(referralLedger);
    console.log('[finance] referral-ledger:create', JSON.stringify({ tenantId, orderId: order.id, referralCode: referralCfg.code }));
  } else {
    console.log('[finance] referral-ledger:skip', JSON.stringify({
      tenantId,
      orderId: order.id,
      reason: referralCfg.code ? 'already_exists' : 'missing_referral_config'
    }));
  }
}

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

function tenantAssetUrlToFilePath(req, rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url || !url.startsWith('/')) return null;
  if (url.startsWith(`/tenants/${req.tenant.id}/media/`)) {
    const relativePath = url.replace(`/tenants/${req.tenant.id}/media/`, '');
    return path.join(req.tenantPaths.media, relativePath);
  }
  return path.join(__dirname, 'public', url.slice(1));
}

function buildTenantAssetAudit(req, config, categories) {
  const homepage = (config && config.homepage) || {};
  const safeCategories = Array.isArray(categories) ? categories : [];
  const evaluate = (label, assetUrl, driver) => {
    const localPath = tenantAssetUrlToFilePath(req, assetUrl);
    const exists = !!(localPath && fs.existsSync(localPath));
    return { label, url: String(assetUrl || ''), exists, driver };
  };
  return {
    headerBanner: evaluate('Header banner', homepage.heroImage, 'homepage.heroImage + homepage.blockVisibility.hero'),
    navMenuPlates: safeCategories.map((cat) => evaluate(
      `Nav/Menu plate: ${resolveTranslatable(cat.name, 'el') || cat.id || cat.slug || 'category'}`,
      cat.image,
      'categories[].image + main navigation/category links'
    )),
    categoryCards: safeCategories.map((cat) => evaluate(
      `Category card: ${resolveTranslatable(cat.name, 'el') || cat.id || cat.slug || 'category'}`,
      cat.image,
      'categories[].image rendered by eukolakis category tiles'
    )),
    introAssets: [
      evaluate('Intro logo', config.logoPath, 'config.logoPath + homepage.introEnabled'),
      evaluate('Intro video', homepage.introVideoUrl, 'homepage.introMode=video + homepage.introVideoUrl'),
      evaluate('Intro poster', homepage.introPosterUrl, 'homepage.introMode=video + homepage.introPosterUrl')
    ]
  };
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

function shouldCanonicalizeToWwwHost(tenant, hostHeader) {
  const host = normalizeHost(hostHeader);
  if (!tenant || tenant.canonicalToWww !== true || !host || host.startsWith('www.')) return false;
  if (host.endsWith('.up.railway.app') || host.endsWith('.railway.internal')) return false;
  if (host.includes('.thronoscommerce.thronoschain.org') || host.includes('.thonoscommerce.thronoschain.org')) return false;
  const hosts = tenantHostnames(tenant);
  if (!hosts.has(host)) return false;
  return hosts.has(`www.${host}`);
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
    homepage: {
      showSubscriptionsCard: false,
      introEnabled: false,
      introVideoUrl: '',
      introPosterUrl: '',
      blockOrder: ['hero', 'kits', 'spare', 'subscriptions'],
      blockVisibility: {
        hero: true,
        kits: true,
        spare: true,
        subscriptions: true
      },
      blockContent: {
        kitsTitle: '',
        spareTitle: '',
        subscriptionsTitle: '',
        kitsCtaLabel: '',
        kitsCtaHref: '',
        spareCtaLabel: '',
        spareCtaHref: '',
        subscriptionsCtaLabel: '',
        subscriptionsCtaHref: ''
      }
    },
    footer: {
      contactEmail: '',
      pickupAddress: '',
      facebookUrl: '',
      instagramUrl: '',
      tiktokUrl: '',
      poweredByEnabled: true,
      poweredByText: 'Powered by Thronos Commerce ↗',
      poweredByUrl: 'https://thronoscommerce.thronoschain.org/'
    },
    favicon: {
      path: '',
      mime: '',
      updatedAt: 0
    },
    assistant: {
      enabled: false,
      apiKey: '',
      webhookUrl: '',
      notifyNewOrders: true,
      notifyLowStock: true,
      notifyTrackingReminder: true,
      lowStockThreshold: 3,
      /* Virtual Assistant store-facing settings */
      vaEnabled: false,
      vaMode: 'disabled',          /* disabled | customer | merchant | both */
      vaLanguage: 'auto',           /* el | en | auto */
      vaTone: 'friendly',          /* friendly | professional | technical */
      vaBrandVoice: '',
      vaStoreInstructions: '',
      vaProductGuidance: '',
      vaCustomerSupport: '',
      vaAvoidTopics: '',
      vaMerchantGoals: ''
    },
    notifications: {
      enabled: false,
      notificationEmail: '',
      replyToEmail: '',
      supportEmail: ''
    },
    theme: {
      presetId: DEFAULT_THEME_KEY,
      menuBg: '#111111',
      menuText: '#ffffff',
      menuActiveBg: '#f06292',
      menuActiveText: '#ffffff',
      buttonRadius: '4px',
      headerLayout: 'default',
      authPosition: 'right',
      menuStyle: 'classic',
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
      logoMaxHeight: 88,
      productThumbAspect: '4:3',
      productThumbFit: 'cover',
      productThumbBg: '#111111',
      productCardHoverEffect: 'lift',
      cardDensity: 'normal',
      productPreOpenEffect: 'none',
      footerTextColor: '#6b7280',
      kitWizardDisplay: 'sequential',
      spareToolsCardMode: 'prominent',
      enableDiyQuickScenario: false,
      kitWizardSkipRule: 'none',
      homeLayoutPreset: 'split'
    }
  };
  const cfg = loadJson(req.tenantPaths.config, fallback);
  const hasStoredKitWizardDisplay = !!(
    cfg &&
    cfg.theme &&
    typeof cfg.theme.kitWizardDisplay === 'string' &&
    String(cfg.theme.kitWizardDisplay).trim()
  );
  cfg.homepage = Object.assign({}, fallback.homepage, cfg.homepage || {});
  cfg.homepage.secondaryCard = Object.assign(
    { title: '', text: '', link: '', image: '' },
    (cfg.homepage && cfg.homepage.secondaryCard) || {}
  );
  cfg.homepage.blockVisibility = Object.assign(
    { hero: true, kits: true, spare: true, subscriptions: true },
    (cfg.homepage && cfg.homepage.blockVisibility) || {}
  );
  cfg.homepage.blockContent = Object.assign(
    {
      kitsTitle: '', spareTitle: '', subscriptionsTitle: '',
      kitsCtaLabel: '', kitsCtaHref: '',
      spareCtaLabel: '', spareCtaHref: '',
      subscriptionsCtaLabel: '', subscriptionsCtaHref: ''
    },
    (cfg.homepage && cfg.homepage.blockContent) || {}
  );
  cfg.footer = Object.assign({}, fallback.footer, cfg.footer || {});
  cfg.favicon = Object.assign({}, fallback.favicon, cfg.favicon || {});
  cfg.assistant = Object.assign({}, fallback.assistant, cfg.assistant || {});
  cfg.assistant = normalizeAssistantConfig(cfg.assistant);
  cfg.notifications = Object.assign({}, fallback.notifications, cfg.notifications || {});
  cfg.theme = Object.assign({}, fallback.theme, cfg.theme || {});
  cfg.theme.presetId = resolveThemeKeyForTenant(req.tenant, cfg.theme.presetId || DEFAULT_THEME_KEY);
  cfg.logoPath = normalizeMediaPath(cfg.logoPath || fallback.logoPath);
  cfg.homepage.heroImage = normalizeMediaPath(cfg.homepage.heroImage);
  cfg.homepage.secondaryCard.image = normalizeMediaPath(cfg.homepage.secondaryCard.image);
  cfg.homepage.secondaryCard.link = String(cfg.homepage.secondaryCard.link || '').trim();
  cfg.homepage.introVideoUrl = normalizeMediaPath(cfg.homepage.introVideoUrl, { allowAbsoluteUrl: true });
  cfg.homepage.introPosterUrl = normalizeMediaPath(cfg.homepage.introPosterUrl, { allowAbsoluteUrl: true });
  const introModes = new Set(['basic', 'assembly', 'video']);
  cfg.homepage.introMode = introModes.has(String(cfg.homepage.introMode || '').trim().toLowerCase())
    ? String(cfg.homepage.introMode).trim().toLowerCase()
    : 'basic';
  cfg.homepage.introTagline = String(cfg.homepage.introTagline || '').trim();
  cfg.homepage.blockOrder = Array.isArray(cfg.homepage.blockOrder)
    ? cfg.homepage.blockOrder.filter((key) => ['hero', 'kits', 'spare', 'subscriptions'].includes(String(key))).slice(0, 4)
    : ['hero', 'kits', 'spare', 'subscriptions'];
  if (cfg.homepage.blockOrder.length === 0) cfg.homepage.blockOrder = ['hero', 'kits', 'spare', 'subscriptions'];
  const paymentOptions = Array.isArray(cfg.paymentOptions) ? cfg.paymentOptions.slice() : [];
  const hasCod = paymentOptions.some((opt) => {
    const id = String((opt && (opt.id || opt.type)) || '').toLowerCase();
    return id === 'cod' || id === 'cash_on_delivery';
  });
  if (!hasCod) {
    paymentOptions.unshift({ id: 'COD', label: 'Αντικαταβολή', type: 'cod' });
  }
  cfg.paymentOptions = paymentOptions;
  if (!hasStoredKitWizardDisplay && cfg.theme && cfg.theme.presetId === 'eukolakis_classic_diy') {
    cfg.theme.kitWizardDisplay = 'cinematic';
  }
  return cfg;
}

function loadTenantProducts(req) {
  const raw = loadJson(req.tenantPaths.products, []);
  if (!Array.isArray(raw)) return [];
  return raw.map((product) => normalizeProductRecord(product));
}

function normalizeGalleryImages(raw) {
  const source = Array.isArray(raw)
    ? raw
    : String(raw || '')
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean);
  const seen = new Set();
  const normalized = [];
  source.forEach((entry) => {
    const url = normalizeMediaPath(entry, { allowAbsoluteUrl: true });
    if (!url || seen.has(url)) return;
    seen.add(url);
    normalized.push(url);
  });
  return normalized;
}

function normalizeProductRecord(product) {
  if (!product || typeof product !== 'object') return {};
  const normalized = { ...product };
  normalized.imageUrl = normalizeMediaPath(normalized.imageUrl || '', { allowAbsoluteUrl: true });
  const combinedGallery = []
    .concat(Array.isArray(normalized.galleryImages) ? normalized.galleryImages : [])
    .concat(Array.isArray(normalized.gallery) ? normalized.gallery : [])
    .concat(typeof normalized.galleryImages === 'string' ? [normalized.galleryImages] : [])
    .concat(typeof normalized.gallery === 'string' ? [normalized.gallery] : []);
  const galleryImages = normalizeGalleryImages(combinedGallery)
    .filter((url) => url && url !== normalized.imageUrl);
  normalized.galleryImages = galleryImages;
  normalized.gallery = galleryImages; // backward compatibility for existing templates/data
  return normalized;
}

function loadTenantCategories(req) {
  const raw = loadJson(req.tenantPaths.categories, []);
  const list = Array.isArray(raw) ? raw : [];
  const normalized = [];
  const usedIds = new Set();
  const usedSlugs = new Set();
  let adjustedCount = 0;
  list.forEach((cat, idx) => {
    const next = normalizeCategoryRecord(cat, idx);
    let id = next.id;
    let slug = next.slug;
    let suffix = 2;
    while (usedIds.has(id)) { id = `${next.id}-${suffix++}`; }
    suffix = 2;
    while (usedSlugs.has(slug)) { slug = `${next.slug}-${suffix++}`; }
    usedIds.add(id);
    usedSlugs.add(slug);
    const normalizedCategory = { ...next, id, slug };
    const original = cat && typeof cat === 'object' ? cat : {};
    if (
      normalizedCategory.id !== String(original.id || '') ||
      normalizedCategory.slug !== String(original.slug || '') ||
      normalizedCategory.image !== normalizeMediaPath(original.image) ||
      normalizedCategory.showInMainNav !== (original.showInMainNav !== undefined ? original.showInMainNav !== false : (original.visible !== false && original.inMainNav !== false))
    ) adjustedCount += 1;
    normalized.push(normalizedCategory);
  });
  if (adjustedCount > 0) {
    console.warn('[tenant-config] categories-normalized', JSON.stringify({
      tenantId: req && req.tenant ? req.tenant.id : null,
      total: normalized.length,
      adjusted: adjustedCount
    }));
  }
  return normalized;
}

function loadTenantUsers(req) {
  const users = loadJson(req.tenantPaths.users, []);
  return Array.isArray(users) ? users : [];
}

function saveTenantUsers(req, users) {
  saveJson(req.tenantPaths.users, users);
}

function saveTenantProducts(req, products) {
  const safeProducts = Array.isArray(products) ? products.map((p) => normalizeProductRecord(p)) : [];
  saveJson(req.tenantPaths.products, safeProducts);
  backupJsonWithRotation(req, 'products', safeProducts);
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

function deriveTrackingUrl(carrier, trackingNumber) {
  const number = String(trackingNumber || '').trim();
  if (!number) return '';
  const normalizedCarrier = String(carrier || '').trim().toLowerCase();
  const encoded = encodeURIComponent(number);
  if (normalizedCarrier === 'acs') return `https://www.acscourier.net/el/track-and-trace/?tracking=${encoded}`;
  if (normalizedCarrier === 'elta') return `https://elta.gr/track?code=${encoded}`;
  if (normalizedCarrier === 'geniki') return `https://www.taxydromiki.com/track?voucher=${encoded}`;
  if (normalizedCarrier === 'dhl') return `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${encoded}`;
  if (normalizedCarrier === 'courier_center') return `https://www.courier.gr/track?voucher=${encoded}`;
  if (normalizedCarrier === 'boxnow') return `https://track.boxnow.gr/?trackingNumber=${encoded}`;
  return '';
}

function normalizeFulfillmentStatus(order) {
  const raw = String(order && order.fulfillmentStatus ? order.fulfillmentStatus : '').trim().toLowerCase();
  const allowed = new Set(['pending_payment', 'cod_pending', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'issue']);
  if (allowed.has(raw)) return raw;
  const paymentStatus = String(order && order.paymentStatus ? order.paymentStatus : '').toUpperCase();
  if (paymentStatus === 'PAID') return 'ready_to_ship';
  if (paymentStatus === 'PENDING_STRIPE') return 'pending_payment';
  if (paymentStatus === 'PENDING_COD') return 'cod_pending';
  if (paymentStatus === 'CANCELLED') return 'cancelled';
  return 'ready_to_ship';
}

// An order is "unresolved" (still needs admin action) if it has not yet reached
// a terminal state (delivered or cancelled). The "issue" status is explicitly unresolved.
function isOrderUnresolved(order) {
  const status = normalizeFulfillmentStatus(order);
  return status !== 'delivered' && status !== 'cancelled';
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

function normalizeOrderForFulfillment(order) {
  const trackingCarrier = String(order && order.trackingCarrier ? order.trackingCarrier : '').trim().toLowerCase();
  const trackingNumber = String(order && order.trackingNumber ? order.trackingNumber : '').trim();
  const trackingUrl = String(order && order.trackingUrl ? order.trackingUrl : '').trim() || deriveTrackingUrl(trackingCarrier, trackingNumber);
  const shippedAt = order && order.shippedAt ? order.shippedAt : null;
  const deliveredAt = order && order.deliveredAt ? order.deliveredAt : null;
  return {
    ...order,
    fulfillmentStatus: normalizeFulfillmentStatus(order),
    trackingCarrier,
    trackingNumber,
    trackingUrl,
    shippedAt,
    deliveredAt,
    hasTracking: !!trackingNumber
  };
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

function buildIntroSeenKey(req) {
  const tenantPart = sanitizeMediaSegment(req && req.tenant && req.tenant.id ? req.tenant.id : 'tenant', 'tenant');
  const hostPart = sanitizeMediaSegment(normalizeHost((req && req.headers && req.headers.host) || 'host'), 'host');
  return `intro_seen_${tenantPart}_${hostPart}`;
}

function requireUser(req, res, next) {
  if (!req.session.user) {
    return res.redirect(buildTenantLink(req, '/login'));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    console.log('[tenant-admin] auth-check', JSON.stringify({
      ok: false,
      reason: 'missing_admin_session',
      path: req.originalUrl || req.url,
      tenantId: req.tenant ? req.tenant.id : null
    }));
    return res.redirect(buildTenantLink(req, '/admin/login'));
  }
  if (!req.tenant || req.session.admin.tenantId !== req.tenant.id) {
    console.log('[tenant-admin] auth-check', JSON.stringify({
      ok: false,
      reason: 'tenant_mismatch',
      path: req.originalUrl || req.url,
      tenantId: req.tenant ? req.tenant.id : null,
      adminTenantId: req.session.admin.tenantId
    }));
    return res.redirect(buildTenantLink(req, '/admin/login'));
  }
  console.log('[tenant-admin] auth-check', JSON.stringify({
    ok: true,
    path: req.originalUrl || req.url,
    tenantId: req.tenant ? req.tenant.id : null,
    adminTenantId: req.session.admin.tenantId
  }));
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
  return calculateCartTotalsWithDiscounts(config, cartItems, shippingMethodId, paymentMethodId, '');
}

function normalizeCouponCode(value) {
  return String(value || '').trim().toUpperCase();
}

function resolveCouponDiscount(config, couponCode, subtotal) {
  const code = normalizeCouponCode(couponCode);
  if (!code) return { code: '', discount: 0 };
  const coupons = Array.isArray(config && config.coupons) ? config.coupons : [];
  if (!coupons.length && code === 'WELCOME10') {
    return { code, discount: Math.max(0, Math.min(subtotal * 0.10, subtotal)) };
  }
  const coupon = coupons.find((c) => normalizeCouponCode(c.code) === code && c.active !== false);
  if (!coupon) return { code: '', discount: 0 };
  const minSubtotal = Number(coupon.minSubtotal) || 0;
  if (subtotal < minSubtotal) return { code: '', discount: 0 };
  const type = String(coupon.type || 'percent').toLowerCase();
  const rawValue = Number(coupon.value) || 0;
  const discount = type === 'fixed'
    ? rawValue
    : subtotal * Math.max(0, Math.min(0.95, rawValue / 100));
  return { code, discount: Math.max(0, Math.min(discount, subtotal)) };
}

function calculateCartTotalsWithDiscounts(config, cartItems, shippingMethodId, paymentMethodId, couponCode) {
  const shippingMethod = (config.shippingOptions || []).find((s) => s.id === shippingMethodId);
  const paymentMethod  = (config.paymentOptions  || []).find((p) => p.id === paymentMethodId);
  if (!shippingMethod) throw new Error('Invalid shipping method');
  if (!paymentMethod)  throw new Error('Invalid payment method');
  if (
    Array.isArray(shippingMethod.allowedPaymentMethods) &&
    !shippingMethod.allowedPaymentMethods.includes(paymentMethod.id)
  ) throw new Error('Ο συγκεκριμένος τρόπος πληρωμής δεν είναι διαθέσιμος για αυτή τη μέθοδο αποστολής.');

  const subtotalBeforeDiscount     = cartItems.reduce((s, i) => s + (Number(i.price) || 0) * (i.qty || 1), 0);
  const quantityDiscount = cartItems.reduce((s, i) => {
    const qty = Number(i.qty) || 1;
    const lineSubtotal = (Number(i.price) || 0) * qty;
    const rate = qty >= 10 ? 0.10 : (qty >= 5 ? 0.05 : 0);
    return s + (lineSubtotal * rate);
  }, 0);
  const subtotalAfterQtyDiscount = Math.max(0, subtotalBeforeDiscount - quantityDiscount);
  const coupon = resolveCouponDiscount(config, couponCode, subtotalAfterQtyDiscount);
  const subtotal = Math.max(0, subtotalAfterQtyDiscount - coupon.discount);
  const shippingCost = Number(shippingMethod.base) || 0;
  const codFee       = paymentMethod.id === 'COD' ? Number(shippingMethod.codFee || 0) : 0;
  const gatewayFee   = subtotal * (Number(paymentMethod.gatewaySurchargePercent) || 0);
  const total        = subtotal + shippingCost + codFee + gatewayFee;
  return {
    subtotalBeforeDiscount,
    quantityDiscount,
    couponCodeApplied: coupon.code,
    couponDiscount: coupon.discount,
    subtotal,
    shippingCost,
    codFee,
    gatewayFee,
    total,
    shippingMethod,
    paymentMethod
  };
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

const ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
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
// SECURITY: Root admin password fail-fast — Phase 0 hardening
const ROOT_ADMIN_PASSWORD = process.env.THRONOS_ROOT_ADMIN_PASSWORD;
if (!ROOT_ADMIN_PASSWORD) {
    console.error('FATAL: THRONOS_ROOT_ADMIN_PASSWORD environment variable is required');
    process.exit(1);
}

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
    theme: {
      menuBg: '#111111',
      menuText: '#ffffff',
      menuActiveBg: '#f06292',
      menuActiveText: '#ffffff',
      buttonRadius: '4px',
      headerLayout: 'default',
      authPosition: 'right',
      menuStyle: 'classic'
    }
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
  if (process.env.EMAIL_ENABLED === 'false') {
    console.log('[mailer] EMAIL_ENABLED=false — email disabled.');
    return null;
  }
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

  const notif = (config && config.notifications) || {};
  const replyToEmail = (notif.replyToEmail || '').trim();
  const cc = config.notificationCcCustomer ? order.email : undefined;
  const mailMsg = {
    from,
    to: recipients,
    ...(cc ? { cc } : {}),
    ...(replyToEmail ? { replyTo: replyToEmail } : {}),
    subject,
    text: lines.join('\n')
  };
  await transport.sendMail(mailMsg);
  console.log(`[Thronos Commerce] Order email sent for ${order.id} → ${recipients}`);
}

async function sendTrackingUpdateEmail({ tenant, config, order }) {
  const transport = buildTransport();
  if (!transport) return;
  const recipient = normalizeEmail(order && order.email);
  if (!recipient) return;
  const notif = (config && config.notifications) || {};
  const storeName = resolveTranslatable(config.storeName, DEFAULT_CONTENT_LANG);
  const fromName = config.notificationFromName || storeName || 'Thronos Commerce Store';
  const from = `"${fromName}" <${process.env.THRC_SMTP_FROM || process.env.THRC_SMTP_USER}>`;
  const replyToEmail = (notif.replyToEmail || '').trim();
  const subject = `[${tenant.id}] Tracking update — παραγγελία #${order.id}`;
  const trackingUrl = order.trackingUrl || '';
  const lines = [
    `Παραγγελία: #${order.id}`,
    `Κατάσταση: ${order.fulfillmentStatus || 'ready_to_ship'}`,
    `Αριθμός tracking: ${order.trackingNumber || '—'}`,
    `Μεταφορέας: ${order.trackingCarrier || '—'}`,
    ...(trackingUrl ? [`Παρακολούθηση: ${trackingUrl}`] : []),
    '',
    storeName
  ];
  const mailMsg = { from, to: recipient, subject, text: lines.join('\n') };
  if (replyToEmail) mailMsg.replyTo = replyToEmail;
  await transport.sendMail(mailMsg);
  console.log(`[Thronos Commerce] Tracking email sent for ${order.id} → ${recipient}`);
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

/**
 * Fire-and-forget: POST a properly-structured commerce event to the VA service.
 *
 * The VA expects:
 *   POST <THRONOS_ASSISTANT_URL>/api/v1/webhooks/commerce
 *   Header: X-Thronos-Signature: sha256=<hmac-sha256 of body>
 *   Body:   { event: "order.placed"|"order.status_changed"|"product.updated",
 *              tenant_id: <string>, data: { ... } }
 *
 * Signing key: COMMERCE_WEBHOOK_SECRET env var (must match VA's COMMERCE_WEBHOOK_SECRET).
 * If the env var is absent, the signature header is omitted (VA will allow it in dev mode).
 */
async function fireVASync(tenantId, event, data) {
  const vaUrl = (process.env.THRONOS_ASSISTANT_URL || process.env.ASSISTANT_API_URL || '').replace(/\/$/, '');
  if (!vaUrl) return;

  const body = JSON.stringify({ event, tenant_id: tenantId, data });
  const headers = { 'Content-Type': 'application/json' };

  const secret = (process.env.COMMERCE_WEBHOOK_SECRET || '').trim();
  if (secret) {
    headers['X-Thronos-Signature'] =
      'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  try {
    await axios.post(`${vaUrl}/api/v1/webhooks/commerce`, body, { headers, timeout: 4000 });
    console.log(`[va-sync] ${event} → ${tenantId}`);
  } catch (err) {
    console.warn(`[va-sync] ${event} failed (${tenantId}):`, err.message);
  }
}

async function dispatchAssistantEvent(req, eventType, payload) {
  const config = loadTenantConfig(req);
  const assistant = (config && config.assistant) || {};
  if (!assistant.enabled) return;
  const webhookUrl = String(assistant.webhookUrl || '').trim();
  if (!webhookUrl) return;
  const apiKey = String(assistant.apiKey || process.env.THRC_ASSISTANT_API_KEY || '').trim();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Thronos-Assistant-Key'] = apiKey;
  const eventPayload = {
    tenantId: req.tenant.id,
    eventType,
    timestamp: new Date().toISOString(),
    payload
  };
  try {
    await axios.post(webhookUrl, eventPayload, { timeout: 3500, headers });
  } catch (err) {
    console.warn('[assistant-event] failed:', err.message);
  }
}

// ── Order confirmation emails (uses platform THRC_SMTP_* transport) ─────────────
// Tenant notification settings live in config.notifications (set via admin panel).
// No tenant-level SMTP credentials — all mail goes through the platform transport.

async function sendOrderEmails(order, config) {
  const transport = buildTransport();
  if (!transport) {
    console.log('[Thronos Commerce] Platform SMTP not configured – skipping sendOrderEmails.');
    return;
  }

  const notif = (config && config.notifications) || {};
  // notificationEmail: where merchant order alerts go (tenant-configured, no env fallback)
  const notificationEmail = (notif.notificationEmail || (config.notificationEmails && config.notificationEmails[0]) || '').trim();
  const replyToEmail = (notif.replyToEmail || '').trim();
  const storeName = resolveTranslatable(config.storeName, DEFAULT_CONTENT_LANG);
  const fromName = storeName || 'Thronos Commerce';
  const from = `"${fromName}" <${process.env.THRC_SMTP_FROM || process.env.THRC_SMTP_USER}>`;

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

  // Merchant notification
  if (notificationEmail) {
    const merchantMsg = { from, to: notificationEmail,
      subject: `[${order.tenantId || order.tenant && order.tenant.id}] Νέα παραγγελία #${order.id} – ${order.productName}`,
      text: `Νέα παραγγελία στο κατάστημα ${storeName}!\n\n${bodyLines}`
    };
    if (replyToEmail) merchantMsg.replyTo = replyToEmail;
    sends.push(transport.sendMail(merchantMsg));
  }

  // Customer confirmation
  if (order.email && notif.enabled !== false) {
    const supportEmail = (notif.supportEmail || replyToEmail || '').trim();
    const customerMsg = { from, to: order.email,
      subject: `Επιβεβαίωση παραγγελίας #${order.id} – ${storeName}`,
      text: `Γεια σας ${order.customerName},\n\nΛάβαμε την παραγγελία σας!\n\n${bodyLines}\n\nΕυχαριστούμε!\n${storeName}${supportEmail ? '\n\nΕπικοινωνία: ' + supportEmail : ''}`
    };
    if (replyToEmail) customerMsg.replyTo = replyToEmail;
    sends.push(transport.sendMail(customerMsg));
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
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|webp|jpeg)$/.test(String(file.mimetype || ''))),
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
const productsImageUpload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|webp|jpeg)$/.test(String(file.mimetype || ''))),
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join((req.tenantPaths && req.tenantPaths.media) || path.join(TENANTS_DIR, '_uploads'), 'products');
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      const base = path.basename(file.originalname || 'product', ext).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      cb(null, `${Date.now()}-${base}${ext}`);
    }
  })
});
const bannerUpload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|webp|jpeg)$/.test(String(file.mimetype || ''))),
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join((req.tenantPaths && req.tenantPaths.media) || path.join(TENANTS_DIR, '_uploads'), 'banners');
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      const base = path.basename(file.originalname || 'banner', ext).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      cb(null, `${Date.now()}-${base}${ext}`);
    }
  })
});
function sanitizeMediaSegment(value, fallback) {
  const clean = String(value || '')
    .trim()
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

function getVariantMediaMeta(req) {
  const productId = sanitizeMediaSegment(
    (req && req.query && req.query.productId) || (req && req.body && req.body.productId),
    'unknown-product'
  );
  const variantSku = sanitizeMediaSegment(
    (req && req.query && req.query.variantSku) || (req && req.body && req.body.variantSku),
    'unknown-variant'
  );
  return { productId, variantSku };
}

const variantImageUpload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|webp|jpeg)$/.test(String(file.mimetype || ''))),
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const { productId, variantSku } = getVariantMediaMeta(req);
      const mediaBase = (req.tenantPaths && req.tenantPaths.media) || path.join(TENANTS_DIR, '_uploads');
      const dir = path.join(mediaBase, 'variants', productId, variantSku);
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ['.png', '.webp', '.jpg', '.jpeg'].includes(ext) ? ext : '.jpg';
      const base = sanitizeMediaSegment(path.basename(file.originalname || 'variant-image', ext), 'variant-image');
      cb(null, `${Date.now()}-${base}${safeExt}`);
    }
  })
});
const variantVideoUpload = multer({
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^video\/(mp4|webm)$/.test(String(file.mimetype || ''))),
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const { productId, variantSku } = getVariantMediaMeta(req);
      const mediaBase = (req.tenantPaths && req.tenantPaths.media) || path.join(TENANTS_DIR, '_uploads');
      const dir = path.join(mediaBase, 'variants', productId, variantSku);
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ['.mp4', '.webm'].includes(ext) ? ext : '.mp4';
      const base = sanitizeMediaSegment(path.basename(file.originalname || 'variant-video', ext), 'variant-video');
      cb(null, `${Date.now()}-${base}${safeExt}`);
    }
  })
});
const cursorUpload = multer({
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|webp|jpeg)$/.test(String(file.mimetype || ''));
    cb(null, ok);
  },
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join((req.tenantPaths && req.tenantPaths.media) || path.join(TENANTS_DIR, '_uploads'), 'cursors');
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      const safeExt = ['.png', '.webp', '.jpg', '.jpeg'].includes(ext) ? ext : '.png';
      const base = path.basename(file.originalname || 'cursor', ext).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      cb(null, `${Date.now()}-${base}${safeExt}`);
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

function collectEjsTemplates(dir) {
  const templates = [];
  if (!fs.existsSync(dir)) return templates;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      templates.push(...collectEjsTemplates(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ejs')) {
      templates.push(fullPath);
    }
  }
  return templates;
}

function preflightCompileTemplates() {
  const viewsDir = app.get('views');
  const templates = collectEjsTemplates(viewsDir);
  const failures = [];
  for (const templatePath of templates) {
    try {
      const source = fs.readFileSync(templatePath, 'utf8');
      ejs.compile(source, { filename: templatePath });
    } catch (e) {
      failures.push({ templatePath, message: e.message });
    }
  }
  if (failures.length) {
    console.error('[boot] EJS preflight failed:');
    failures.forEach((failure) => {
      console.error(`- ${path.relative(__dirname, failure.templatePath)}: ${failure.message}`);
    });
    return false;
  }
  return true;
}

// Security headers
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:; frame-ancestors 'self'; base-uri 'self';");
  next();
});

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  env: process.env.NODE_ENV || 'development',
  emailEnabled: process.env.EMAIL_ENABLED !== 'false' && !!(process.env.THRC_SMTP_HOST),
}));
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nDisallow: /admin\n');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/tenants', express.static(TENANTS_DIR));
// Raw body for Stripe webhook signature verification (must be before urlencoded)
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('trust proxy', 1);
// SECURITY: Hardcoded session secret removed — Phase 0 hardening
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET environment variable is required');
    process.exit(1);
}
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto'
  }
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

app.use((req, res, next) => {
  const info = detectDeviceInfo(req);
  req.deviceInfo = info;
  res.locals.device = info.device;
  res.locals.os = info.os;
  next();
});

// Tenant resolution middleware (skips root operator panel)
app.use((req, res, next) => {
  if (req.path.startsWith('/root')) return next();
  const hostHeader = normalizeHost(req.headers.host || '');
  const requestedTenant = (req.query.tenant || '').trim();
  let tenant = null;
  let mode = 'host';
  let isPlatformRequest = false;
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
    const tenants = loadTenantsRegistry();
    const hostResolution = resolveTenantFromHost(hostHeader, tenants);
    if (hostResolution.type === 'tenant') {
      tenant = hostResolution.tenant;
      mode = 'host';
    } else if (hostResolution.type === 'platform') {
      isPlatformRequest = true;
      tenant = findTenantById('demo') || (Array.isArray(tenants) && tenants.length ? tenants[0] : null);
      mode = 'platform-host';
    } else {
      return res.status(404).render('tenant-not-found', {
        host: hostHeader,
        supportEmail: process.env.SUPPORT_EMAIL || 'support@thronoschain.org'
      });
    }
  }
  if (!tenant) {
    const allTenants = loadTenantsRegistry();
    if (Array.isArray(allTenants) && allTenants.length) {
      tenant = allTenants[0];
      mode = mode === 'host' ? 'registry-fallback' : mode;
    }
  }
  if (!tenant) {
    return res
      .status(503)
      .send('No tenant configured for this host. Check tenants.json.');
  }
  if (mode === 'host' && shouldCanonicalizeToWwwHost(tenant, hostHeader)) {
    const canonicalHost = `www.${hostHeader}`;
    const target = `${req.protocol}://${canonicalHost}${req.originalUrl || req.url || '/'}`;
    return res.redirect(308, target);
  }
  req.tenant = tenant;
  req.tenantId = tenant.id;
  req.tenantContext = { mode };
  req.isPlatformRequest = isPlatformRequest;
  req.tenantPaths = tenantPaths(tenant.id);
  res.locals.user = req.session ? req.session.user : null;
  res.locals.tenantId = tenant.id;
  res.locals.tenantContext = req.tenantContext;
  res.locals.tenantBasePath = req.tenantContext.mode === 'path' ? `/t/${tenant.id}` : '';
  res.locals.isPreviewMode = req.tenantContext.mode === 'path' || req.tenantContext.mode === 'query';
  res.locals.withTenantLink = (path, extra) => buildTenantLink(req, path, extra);
  next();
});

// ── Subscription enforcement ──────────────────────────────────────────────
const SUBSCRIPTION_GRACE_DAYS = 10;
const SUBSCRIPTION_EXEMPT_PATHS = ['/admin', '/root', '/login', '/logout', '/signup', '/api', '/checkout', '/cart', '/my-orders', '/account', '/favicon.ico', '/styles.css', '/manifest', '/sitemap'];

app.use((req, res, next) => {
  // Never enforce on platform preview requests or exempt paths
  if (req.isPlatformRequest) return next();
  const p = req.path || '/';
  if (SUBSCRIPTION_EXEMPT_PATHS.some(ep => p === ep || p.startsWith(ep + '/'))) return next();
  if (p.startsWith('/tenants/') || p.match(/\.(js|css|ico|png|jpg|svg|webp|woff|ttf|eot)$/i)) return next();

  const subInfo = getSubscriptionInfo(req.tenant);
  // Only enforce if isGraceExpired (> 10 days overdue)
  if (!subInfo.isGraceExpired) return next();

  // Grace period exceeded — storefront suspended
  const storeName = (req.tenant && req.tenant.id) || 'Store';
  return res.status(402).send(`<!doctype html><html lang="el"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Κατάστημα προσωρινά μη διαθέσιμο</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0b0d12;color:#d0d5e0;min-height:100vh;display:grid;place-items:center;padding:20px}.card{background:#141820;border:1px solid rgba(100,110,140,.28);border-top:2px solid #c4902e;border-radius:16px;padding:40px 32px;max-width:480px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.6)}h1{font-size:1.4rem;font-weight:900;color:#edf0f6;margin-bottom:10px}p{color:#64707f;line-height:1.6;margin-bottom:18px}.badge{display:inline-block;background:#c4902e;color:#fff;font-size:.78rem;font-weight:800;border-radius:6px;padding:4px 12px;margin-bottom:22px;letter-spacing:.04em}a{color:#c4902e;text-decoration:none;font-weight:600}a:hover{text-decoration:underline}</style></head><body><div class="card"><div class="badge">ΣΥΝΔΡΟΜΗ ΛΗΞΗ</div><h1>Το κατάστημα δεν είναι διαθέσιμο αυτή τη στιγμή.</h1><p>Η συνδρομή αυτού του καταστήματος έχει λήξει. Επικοινωνήστε με τον ιδιοκτήτη ή δοκιμάστε ξανά αργότερα.</p><p style="font-size:.82rem;color:#94a3b8;">Αν είστε ο ιδιοκτήτης, <a href="${req.tenantBasePath || ''}/admin">συνδεθείτε στο admin</a> για να ανανεώσετε τη συνδρομή σας.</p></div></body></html>`);
});

// Root admin auth guard
app.use('/root', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  return requireRootAdmin(req, res, next);
});

// Tenant admin auth guard
app.use('/admin', (req, res, next) => {
  console.log('[tenant-admin] route-entry', JSON.stringify({
    host: normalizeHost(req.headers.host || ''),
    path: req.originalUrl || req.url,
    tenantId: req.tenant ? req.tenant.id : null,
    mode: req.tenantContext ? req.tenantContext.mode : null,
    isPlatformRequest: !!req.isPlatformRequest,
    hasAdminSession: !!(req.session && req.session.admin),
    adminTenantId: req.session && req.session.admin ? req.session.admin.tenantId : null
  }));
  if (req.isPlatformRequest) return res.redirect('/');
  if (req.path === '/login' || req.path === '/logout') return next();
  return requireAdmin(req, res, next);
});

function buildAdminViewModel(req, extra) {
  const config = loadTenantConfig(req);
  const faviconPath = (
    config &&
    config.favicon &&
    typeof config.favicon.path === 'string'
      ? config.favicon.path.trim()
      : ''
  );
  const hasConfiguredFavicon = Boolean(faviconPath);
  const products = loadTenantProducts(req).filter((p) => p && p.active !== false);
  const categories = loadTenantCategories(req);
  const assetAudit = buildTenantAssetAudit(req, config, categories);
  const qContentLang = (req.query.contentLang || '').toLowerCase();
  const sContentLang = (req.session && req.session.contentLang ? String(req.session.contentLang) : '').toLowerCase();
  const contentLang = CONTENT_LANGS.includes(qContentLang)
    ? qContentLang
    : (CONTENT_LANGS.includes(sContentLang) ? sContentLang : DEFAULT_CONTENT_LANG);
  if (req.session) req.session.contentLang = contentLang;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  const allowedThemeKeys = getAllowedThemeKeysForTenant(req.tenant);
  const allowedThemes = listThemeCatalog().filter((theme) => allowedThemeKeys.includes(theme.key));
  const activeThemeKey = resolveThemeKeyForTenant(req.tenant, config && config.theme ? config.theme.presetId : DEFAULT_THEME_KEY);
  const orders = loadTenantOrders(req);
  const unresolvedOrdersCount = orders.filter((o) => isOrderUnresolved(o)).length;
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
  const settlementLedger = loadSettlementLedger().filter((row) => row.tenantId === req.tenant.id);
  const referralLedger = loadReferralLedger().filter((row) => row.tenantId === req.tenant.id);
  const pendingSettlementEstimate = settlementLedger
    .filter((row) => row.settlementDirection === 'payable_to_tenant' && ['pending', 'approved', 'partially_settled'].includes(row.status))
    .reduce((sum, row) => sum + Number(row.netSettlementAmount || 0), 0);
  const pendingPlatformDues = settlementLedger
    .filter((row) => row.settlementDirection === 'receivable_from_tenant' && ['pending', 'approved', 'partially_settled'].includes(row.status))
    .reduce((sum, row) => sum + Number(row.netSettlementAmount || 0), 0);
  const pendingReferralImpact = referralLedger
    .filter((row) => ['pending', 'approved'].includes(row.status))
    .reduce((sum, row) => sum + Number(row.commissionAmount || 0), 0);
  const now = Date.now();
  const lastAdminActiveAt = Number(req.session && req.session.adminLastActiveAt ? req.session.adminLastActiveAt : 0);
  const adminReauthRemainingMs = lastAdminActiveAt
    ? Math.max(0, ADMIN_IDLE_TIMEOUT_MS - (now - lastAdminActiveAt))
    : 0;

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
    unresolvedOrdersCount,
    assetAudit,
    hasFavicon: hasConfiguredFavicon || fs.existsSync(req.tenantPaths.favicon),
    subscription: getSubscriptionInfo(req.tenant),
    exportAccess: hasExportAccess(req),
    backups: listRecentBackups(req, 30),
    tickets: tickets.slice().reverse(),
    adminActionTimeoutMs: ADMIN_IDLE_TIMEOUT_MS,
    adminReauthRemainingMs,
    allowedThemeKeys,
    allowedThemes,
    activeThemeKey,
    activeThemeMeta: THEME_CATALOG[activeThemeKey] || THEME_CATALOG[DEFAULT_THEME_KEY],
    financeSummary: {
      pendingSettlementEstimate: +pendingSettlementEstimate.toFixed(2),
      pendingPlatformDues: +pendingPlatformDues.toFixed(2),
      pendingReferralImpact: +pendingReferralImpact.toFixed(2)
    },
    message: null,
    error: null,
    ...(extra || {})
  };
}

function buildAdminPaymentsViewModel(req, extra) {
  const config = loadTenantConfig(req);
  const permissions = getSupportPermissions(req.tenant.supportTier);
  const paymentOptions = Array.isArray(config.paymentOptions) ? config.paymentOptions : [];
  const stripeOpt = paymentOptions.find((p) => p.type === 'stripe' || p.id === 'stripe');
  const paypalOpt = paymentOptions.find((p) => p.type === 'paypal' || p.id === 'paypal');
  return {
    tenant: req.tenant,
    config,
    permissions,
    paymentFlags: {
      stripeEnabled: !!stripeOpt,
      paypalEnabled: !!paypalOpt
    },
    message: null,
    error: null,
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
  const config = loadTenantConfig(req);
  const configuredPath = String(config && config.favicon && config.favicon.path || '').trim();
  const configuredMime = String(config && config.favicon && config.favicon.mime || '').trim();
  if (configuredPath && configuredPath.startsWith(`/tenants/${req.tenant.id}/`)) {
    const resolved = path.join(TENANTS_DIR, configuredPath.replace(`/tenants/${req.tenant.id}/`, `${req.tenant.id}/`));
    if (fs.existsSync(resolved)) {
      if (configuredMime) res.type(configuredMime);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.sendFile(resolved);
    }
  }
  const faviconPath = req.tenantPaths && req.tenantPaths.favicon; // legacy fallback
  if (faviconPath && fs.existsSync(faviconPath)) {
    res.type('image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(faviconPath);
  }
  res.status(204).end();
});

app.get('/sitemap.xml', (req, res) => {
  const config = loadTenantConfig(req);
  const categories = loadTenantCategories(req);
  const products = loadTenantProducts(req).filter((p) => p && p.active !== false);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const urls = [
    buildTenantLink(req, '/'),
    buildTenantLink(req, '/checkout'),
    buildTenantLink(req, '/login'),
    buildTenantLink(req, '/signup')
  ];
  if (config.homepage && config.homepage.introEnabled) urls.push(buildTenantLink(req, '/intro'));
  categories.forEach((cat) => urls.push(buildTenantLink(req, '/', { category: cat.slug || cat.id })));
  products.forEach((p) => urls.push(buildTenantLink(req, `/product/${p.id}`)));
  const uniqueUrls = Array.from(new Set(urls));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${uniqueUrls.map((u) => `  <url><loc>${baseUrl}${u}</loc></url>`).join('\n')}\n</urlset>`;
  res.type('application/xml');
  res.send(xml);
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
  try {
    const config = loadTenantConfig(req);
    const introCookieName = buildIntroSeenKey(req);
    const cookieHeader = String(req.headers.cookie || '');
    const introSeen = new RegExp(`(?:^|;\\s*)${introCookieName}=1(?:;|$)`).test(cookieHeader);
    const skipIntro = String(req.query.skipIntro || '') === '1';
    if (config.homepage && config.homepage.introEnabled && !introSeen && !skipIntro) {
      // Use req.url (already rewritten, tenant-prefix-stripped) so buildTenantLink
      // doesn't double-prepend /t/:tenantId when constructing the ?next= redirect.
      const nextTarget = String(req.url || '/').trim() || '/';
      return res.redirect(buildTenantLink(req, '/intro', Object.assign({ next: nextTarget }, req.lang !== 'el' ? { lang: req.lang } : {})));
    }
    const categories = loadTenantCategories(req);
    const allProducts = loadTenantProducts(req).filter((p) => p && p.active !== false);
    const hydratedAllProducts = allProducts.map((p) => hydrateKitProduct(p, allProducts, req.lang, {
      defaultPartsOnly: shouldDefaultPartsOnly(req.tenant, config)
    }));

    const rawCategory = String(req.query.category || '');
    let catSlug = normalizeSlug(rawCategory);
    if (config && config.theme && config.theme.presetId === 'eukolakis_classic_diy') {
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
    } else if (!config.theme || config.theme.presetId !== 'eukolakis_classic_diy') {
      const homepageCfg = config.homepage || {};
      const featuredIds = []
        .concat(Array.isArray(homepageCfg.featuredPrimary) ? homepageCfg.featuredPrimary : [])
        .concat(Array.isArray(homepageCfg.featuredIds) ? homepageCfg.featuredIds : [])
        .concat(homepageCfg.featuredSecondaryId ? [homepageCfg.featuredSecondaryId] : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      if (featuredIds.length) {
        const featuredSet = new Set(featuredIds);
        products = hydratedAllProducts.filter((p) => featuredSet.has(String(p.id || '').trim()));
      } else {
        products = hydratedAllProducts.slice(0, 8);
      }
    }

    const viewLang = req.lang;
    const localizedConfig = localizeConfigContent(config, viewLang);
    const localizedAllProducts = hydratedAllProducts.map((p) => localizeProductContent(p, viewLang));
    const storefrontAssetAudit = buildTenantAssetAudit(req, config, categories);
    res.render('index', {
      config: localizedConfig,
      categories: categories.map((c) => localizeCategoryContent(c, viewLang)),
      products: products.map((p) => localizeProductContent(p, viewLang)),
      allProducts: localizedAllProducts,
      activeCategory: catSlug || null,
      tenant: req.tenant,
      storefrontAssetAudit,
      subscription: getSubscriptionInfo(req.tenant),
    });
  } catch (err) {
    console.error('[storefront] index render failed:', err && err.stack ? err.stack : err);
    res.status(500).send('<!doctype html><html><body style="font-family:system-ui;padding:20px;"><h2>Store temporarily unavailable</h2><p>Please try again shortly.</p></body></html>');
  }
});

app.get('/intro', (req, res) => {
  if (req.isPlatformRequest) return res.redirect('/');
  try {
    const config = loadTenantConfig(req);
    if (!config.homepage || !config.homepage.introEnabled) {
      return res.redirect(buildTenantLink(req, '/', req.lang !== 'el' ? { lang: req.lang } : {}));
    }
    const rawNext = String(req.query.next || '').trim();
    const safeNext = rawNext && rawNext.startsWith('/') ? rawNext : '/';
    const skipHref = buildTenantLink(req, safeNext, Object.assign({ skipIntro: '1' }, req.lang !== 'el' ? { lang: req.lang } : {}));
    const introCookieName = buildIntroSeenKey(req);
    const introStorageKey = `${introCookieName}_ls`;
    const introAssetAudit = buildTenantAssetAudit(req, config, loadTenantCategories(req));
    return res.render('intro', {
      config: localizeConfigContent(config, req.lang),
      homepage: config.homepage || {},
      tenant: req.tenant,
      introAssetAudit,
      skipHref,
      introCookieName,
      introStorageKey,
      isEukolakisClassic: isEukolakisClassicPreset(req)
    });
  } catch (err) {
    console.error('[intro] render failed:', err && err.stack ? err.stack : String(err));
    return res.redirect(buildTenantLink(req, '/', {}));
  }
});

// Product detail
app.get('/product/:id', (req, res) => {
  const config = loadTenantConfig(req);
  const products = loadTenantProducts(req).filter((p) => p && p.active !== false);
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
  const productCategories = loadTenantCategories(req);
  res.render('product', {
    config: localizeConfigContent(config, req.lang),
    product: localizeProductContent(hydratedProduct, req.lang),
    tenant: req.tenant,
    categories: productCategories,
    storefrontAssetAudit: buildTenantAssetAudit(req, config, productCategories)
  });
});

// Checkout page
app.get('/checkout', (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  res.render('checkout', { config, tenant: req.tenant, user: req.session.user || null });
});

app.post('/api/checkout/cart-snapshot', (req, res) => {
  const raw = req.body && req.body.items;
  if (!Array.isArray(raw)) {
    return res.status(400).json({ ok: false });
  }
  const snapshot = raw
    .filter((item) => item && typeof item === 'object' && String(item.id || '').trim())
    .map((item) => ({
      id: String(item.id || '').trim(),
      qty: Math.max(1, parseInt(item.qty, 10) || 1),
      variantId: item.variantId ? String(item.variantId).trim() : '',
      isKitSummary: !!item.isKitSummary,
      selectedOptions: Array.isArray(item.selectedOptions) ? item.selectedOptions : []
    }))
    .slice(0, 120);
  const tenantId = req.tenant && req.tenant.id ? String(req.tenant.id) : '';
  if (!req.session.checkoutCartSnapshotByTenant || typeof req.session.checkoutCartSnapshotByTenant !== 'object') {
    req.session.checkoutCartSnapshotByTenant = {};
  }
  if (tenantId) {
    req.session.checkoutCartSnapshotByTenant[tenantId] = snapshot;
  }
  console.log('[checkout] cart-snapshot:save', JSON.stringify({
    tenantId,
    count: snapshot.length
  }));
  return res.json({ ok: true, count: snapshot.length });
});

// Checkout submit (multi-item cart)
app.post('/checkout', async (req, res) => {
  console.log('[checkout] submit:start', JSON.stringify({
    tenantId: req.tenant && req.tenant.id,
    host: req.headers.host || '',
    paymentMethodId: req.body && req.body.paymentMethodId
  }));
  const config = loadTenantConfig(req);
  const products = loadTenantProducts(req);
  const {
    name, email, wallet, notes, shippingMethodId, paymentMethodId,
    city, phone, address, doorbell, tk, cartJson, couponCode
  } = req.body;
  const sessionEmail = req.session.user ? normalizeEmail(req.session.user.email) : '';
  const checkoutEmail = sessionEmail || normalizeEmail(email);

  // ── Parse cart items ──────────────────────────────────────────────
  let cartItems = [];
  try { cartItems = JSON.parse(cartJson || '[]'); } catch (_) {}
  const tenantId = req.tenant && req.tenant.id ? String(req.tenant.id) : '';
  const snapshotByTenant = (req.session && req.session.checkoutCartSnapshotByTenant && typeof req.session.checkoutCartSnapshotByTenant === 'object')
    ? req.session.checkoutCartSnapshotByTenant
    : {};
  const tenantSnapshot = tenantId && Array.isArray(snapshotByTenant[tenantId]) ? snapshotByTenant[tenantId] : [];
  if ((!Array.isArray(cartItems) || !cartItems.length) && tenantSnapshot.length) {
    cartItems = tenantSnapshot.slice();
    console.log('[checkout] submit:session-fallback', JSON.stringify({
      tenantId,
      count: cartItems.length
    }));
  }
  if (Array.isArray(cartItems)) {
    cartItems = cartItems
      .filter((item) => item && typeof item === 'object' && String(item.id || '').trim())
      .map((item) => ({
        id: String(item.id || '').trim(),
        qty: Math.max(1, parseInt(item.qty, 10) || 1),
        variantId: item.variantId ? String(item.variantId).trim() : '',
        isKitSummary: !!item.isKitSummary,
        selectedOptions: Array.isArray(item.selectedOptions) ? item.selectedOptions : []
      }))
      .slice(0, 120);
  }
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    console.warn('[checkout] submit:empty-cart', JSON.stringify({
      tenantId: req.tenant && req.tenant.id
    }));
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
            const selectedVariantId = typeof selectedVariantIdRaw === 'string' && selectedVariantIdRaw.trim()
              ? selectedVariantIdRaw.trim()
              : (typeof choice.linkedVariantId === 'string' ? choice.linkedVariantId.trim() : '');
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
        name:         resolveTranslatable(found.name, req.lang) || found.id,
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
    totals = calculateCartTotalsWithDiscounts(config, enrichedItems, shippingMethodId, paymentMethodId, couponCode);
  } catch (err) {
    return res.status(400).send(err.message);
  }

  const orderId = Date.now().toString() + '_' + crypto.randomBytes(6).toString('hex');
  const trackingToken = crypto.randomBytes(8).toString('hex');
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
    paymentOptionsSnapshot: Array.isArray(config.paymentOptions) ? config.paymentOptions : [],
    shippingMethodLabel: totals.shippingMethod.label,
    paymentMethodLabel:  totals.paymentMethod.label,
    subtotal:    totals.subtotal,
    subtotalBeforeDiscount: totals.subtotalBeforeDiscount,
    quantityDiscount: totals.quantityDiscount,
    couponCode: totals.couponCodeApplied || '',
    couponDiscount: totals.couponDiscount || 0,
    shippingCost: totals.shippingCost,
    codFee:      totals.codFee,
    gatewayFee:  totals.gatewayFee,
    total:       totals.total,
    paymentStatus: totals.paymentMethod.type === 'stripe' ? 'PENDING_STRIPE' : 'PENDING_COD',
    fulfillmentStatus: totals.paymentMethod.type === 'stripe' ? 'pending_payment' : 'cod_pending',
    shippedAt: null,
    deliveredAt: null,
    trackingNumber: '',
    trackingCarrier: '',
    trackingUrl: '',
    trackingToken,
    currency: 'EUR',
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

  let proofHash = '';
  try {
    proofHash = await recordOrderOnChain(order, req.tenant);
  } catch (chainErr) {
    console.error('[checkout] chain:attest-failed', chainErr && chainErr.message ? chainErr.message : chainErr);
  }
  order.proofHash = proofHash;
  appendTenantOrder(req, order);
  createFinancialLedgerEntries(req, order);

  // ── Stock deduction (per item) ────────────────────────────────────
  const allProductsMut = loadTenantProducts(req);
  const stockLog = loadJson(req.tenantPaths.stockLog, []);
  const lowStockAlerts = [];
  const lowStockThreshold = Number((config.assistant && config.assistant.lowStockThreshold) || 3);
  enrichedItems.forEach((ci) => {
    if (ci.isKitSummary) return;
    const pIdx = allProductsMut.findIndex((p) => p.id === ci.id);
    if (pIdx < 0) return;
    const prod = allProductsMut[pIdx];
    if (ci.variantId && Array.isArray(prod.variants)) {
      const vIdx = prod.variants.findIndex((v) => v.id === ci.variantId);
      if (vIdx >= 0) {
        prod.variants[vIdx].stock = Math.max(0, (prod.variants[vIdx].stock || 0) - ci.qty);
        if (prod.variants[vIdx].stock <= lowStockThreshold) {
          lowStockAlerts.push({
            productId: ci.id,
            productName: ci.name,
            variantId: ci.variantId,
            variantLabel: ci.variantLabel,
            remainingStock: prod.variants[vIdx].stock
          });
        }
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
      if (prod.stock <= lowStockThreshold) {
        lowStockAlerts.push({
          productId: ci.id,
          productName: ci.name,
          remainingStock: prod.stock
        });
      }
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
  fireVASync(req.tenant.id, 'order.placed', {
    order_number: order.id,
    customer_id: order.email || 'guest',
    status: order.fulfillmentStatus || 'pending',
    total: order.total,
    shipping_cost: order.shippingCost || 0,
    currency: order.currency || 'EUR',
    shipping_method: order.shippingMethodLabel || order.shippingMethodId || '',
    payment_method: order.paymentMethodLabel || order.paymentMethodId || 'COD',
    payment_status: order.paymentStatus || 'pending',
    shipping_address: {
      name: order.customerName,
      street: order.address || '',
      city: order.city || '',
      postal: order.tk || '',
    },
    notes: order.notes || '',
    items: Array.isArray(order.items) ? order.items.map((ci) => ({
      sku: ci.id,
      name: ci.name,
      quantity: ci.qty,
      unit_price: ci.price,
      total_price: (ci.price || 0) * (ci.qty || 1),
    })) : [],
  });
  if (lowStockAlerts.length && config.assistant && config.assistant.notifyLowStock !== false) {
    dispatchAssistantEvent(req, 'low_stock', { alerts: lowStockAlerts, orderId });
  }

  const mailFrom = (process.env.THRC_SMTP_FROM || process.env.THRC_SMTP_USER || '').trim();
  const mailSubject = `Νέα παραγγελία #${order.id} – ${resolveTranslatable(config.storeName, DEFAULT_CONTENT_LANG)}`;
  sendOrderEmails(order, config).catch((err) =>
    console.error('[Thronos Commerce] sendOrderEmails failed:', err.message)
  );
  attestMailToThronos(order, { from: mailFrom, to: [order.email], subject: mailSubject }).catch(
    (err) => console.error('[Thronos Commerce] attestMailToThronos failed:', err.message)
  );

  if (req.session) {
    req.session.lastCompletedOrder = {
      orderId: order.id,
      tenantId: req.tenant.id,
      at: Date.now()
    };
  }
  return res.redirect(303, buildTenantLink(req, '/checkout/complete', { orderId: order.id }));
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
  order.fulfillmentStatus = order.fulfillmentStatus === 'cancelled' ? 'cancelled' : 'ready_to_ship';
  order.stripeSessionId = session_id;
  if (req.session.user) {
    order.userEmail = normalizeEmail(req.session.user.email);
  }

  delete pending[pending_id];
  saveJson(req.tenantPaths.pendingOrders, pending);

  let proofHash = '';
  try {
    proofHash = await recordOrderOnChain(order, req.tenant);
  } catch (chainErr) {
    console.error('[checkout] stripe chain:attest-failed', chainErr && chainErr.message ? chainErr.message : chainErr);
  }
  order.proofHash = proofHash;
  appendTenantOrder(req, order);
  createFinancialLedgerEntries(req, order);

  // Stock deduction
  const allProductsMut = loadTenantProducts(req);
  const stockLog = loadJson(req.tenantPaths.stockLog, []);
  const lowStockAlerts = [];
  const lowStockThreshold = Number((config.assistant && config.assistant.lowStockThreshold) || 3);
  enrichedItems.forEach((ci) => {
    const pIdx = allProductsMut.findIndex((p) => p.id === ci.id);
    if (pIdx < 0) return;
    const prod = allProductsMut[pIdx];
    if (ci.variantId && Array.isArray(prod.variants)) {
      const vIdx = prod.variants.findIndex((v) => v.id === ci.variantId);
      if (vIdx >= 0) {
        prod.variants[vIdx].stock = Math.max(0, (prod.variants[vIdx].stock || 0) - ci.qty);
        if (prod.variants[vIdx].stock <= lowStockThreshold) {
          lowStockAlerts.push({
            productId: ci.id,
            productName: ci.name,
            variantId: ci.variantId,
            variantLabel: ci.variantLabel,
            remainingStock: prod.variants[vIdx].stock
          });
        }
        stockLog.push({ id: Date.now().toString(36) + '_s', productId: ci.id, productName: ci.name, variantId: ci.variantId, variantLabel: ci.variantLabel, delta: -ci.qty, reason: 'stripe_order', orderId: order.id, createdAt: order.createdAt });
      }
    } else if ((prod.stock || 0) > 0) {
      prod.stock = Math.max(0, prod.stock - ci.qty);
      if (prod.stock <= lowStockThreshold) {
        lowStockAlerts.push({
          productId: ci.id,
          productName: ci.name,
          remainingStock: prod.stock
        });
      }
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
  fireVASync(req.tenant.id, 'order.placed', {
    order_number: order.id,
    customer_id: order.email || 'guest',
    status: order.fulfillmentStatus || 'pending',
    total: order.total,
    shipping_cost: order.shippingCost || 0,
    currency: order.currency || 'EUR',
    shipping_method: order.shippingMethodLabel || order.shippingMethodId || '',
    payment_method: order.paymentMethodLabel || 'CARD',
    payment_status: 'paid',
    shipping_address: {
      name: order.customerName,
      street: order.address || '',
      city: order.city || '',
      postal: order.tk || '',
    },
    notes: order.notes || '',
    items: Array.isArray(order.items) ? order.items.map((ci) => ({
      sku: ci.id, name: ci.name, quantity: ci.qty,
      unit_price: ci.price, total_price: (ci.price || 0) * (ci.qty || 1),
    })) : [],
  });

  if (req.session) {
    req.session.lastCompletedOrder = {
      orderId: order.id,
      tenantId: req.tenant.id,
      at: Date.now()
    };
  }
  return res.redirect(303, buildTenantLink(req, '/checkout/complete', { orderId: order.id }));
});

app.get('/checkout/stripe-cancel', (req, res) => res.redirect(buildTenantLink(req, '/checkout')));

app.get('/checkout/complete', (req, res) => {
  const config = loadTenantConfig(req);
  const orders = loadTenantOrders(req);
  const queryOrderId = String(req.query.orderId || '').trim();
  const sessionOrderId = req.session && req.session.lastCompletedOrder && req.session.lastCompletedOrder.tenantId === req.tenant.id
    ? String(req.session.lastCompletedOrder.orderId || '').trim()
    : '';
  const resolvedOrderId = queryOrderId || sessionOrderId;
  if (!resolvedOrderId) {
    return res.redirect(buildTenantLink(req, '/checkout', { error: 'order_not_found' }));
  }
  const order = orders.find((o) => o.id === resolvedOrderId);
  if (!order) {
    return res.redirect(buildTenantLink(req, '/checkout', { error: 'order_not_found' }));
  }
  // Compute content URL if any purchased product has digital content
  const catalogForCompletion = loadTenantProducts(req);
  const hasDigital = (Array.isArray(order.items) ? order.items : []).some((ci) => {
    const p = catalogForCompletion.find((pp) => pp.id === ci.id);
    return p && p.hasDigitalContent;
  });
  if (req.session) {
    const tenantId = req.tenant && req.tenant.id ? String(req.tenant.id) : '';
    if (!req.session.checkoutCartSnapshotByTenant || typeof req.session.checkoutCartSnapshotByTenant !== 'object') {
      req.session.checkoutCartSnapshotByTenant = {};
    }
    if (tenantId) {
      req.session.checkoutCartSnapshotByTenant[tenantId] = [];
    }
    console.log('[checkout] complete:cart-clear', JSON.stringify({
      tenantId,
      orderId: order.id
    }));
  }
  return res.render('thanks', {
    config: localizeConfigContent(config, req.lang),
    order,
    proofHash: order.proofHash || '',
    tenant: req.tenant,
    clearCart: true,
    contentUrl: hasDigital ? buildTenantLink(req, `/content/${order.id}`) : null
  });
});

app.get('/admin/login', (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  if (req.session.admin && req.session.admin.tenantId === req.tenant.id) return res.redirect(buildTenantLink(req, '/admin'));
  console.log('[tenant-admin] render-login', JSON.stringify({
    host: normalizeHost(req.headers.host || ''),
    path: req.originalUrl || req.url,
    tenantId: req.tenant ? req.tenant.id : null
  }));
  res.render('admin-login', { config, tenant: req.tenant, error: null });
});

app.post('/admin/login', async (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  const ok = await verifyAdminPassword(req.tenant, req.body.password);
  if (!ok) {
    console.log('[tenant-admin] login-attempt', JSON.stringify({
      ok: false,
      host: normalizeHost(req.headers.host || ''),
      path: req.originalUrl || req.url,
      tenantId: req.tenant ? req.tenant.id : null
    }));
    return res.status(401).render('admin-login', { config, tenant: req.tenant, error: 'Invalid admin password.' });
  }
  req.session.admin = { tenantId: req.tenant.id, authenticatedAt: new Date().toISOString() };
  req.session.adminLastActiveAt = Date.now();
  console.log('[tenant-admin] login-attempt', JSON.stringify({
    ok: true,
    host: normalizeHost(req.headers.host || ''),
    path: req.originalUrl || req.url,
    tenantId: req.tenant ? req.tenant.id : null
  }));
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
  const orders = loadTenantOrders(req)
    .filter((o) => normalizeEmail(o.userEmail) === email)
    .map((o) => normalizeOrderForFulfillment(o))
    .slice()
    .reverse();
  res.render('my-orders', { config, tenant: req.tenant, user: req.session.user, orders });
});

app.get('/track', (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  return res.render('track-order', { config, tenant: req.tenant, order: null, error: null });
});

app.post('/track', (req, res) => {
  const config = localizeConfigContent(loadTenantConfig(req), req.lang);
  const orderId = String(req.body.orderId || '').trim();
  const email = normalizeEmail(req.body.email || '');
  if (!orderId || !email) {
    return res.status(400).render('track-order', {
      config,
      tenant: req.tenant,
      order: null,
      error: req.lang === 'el' ? 'Συμπλήρωσε Order ID και email.' : 'Provide Order ID and email.'
    });
  }
  const orders = loadTenantOrders(req);
  const order = orders.find((o) => o.id === orderId && normalizeEmail(o.email) === email);
  if (!order) {
    return res.status(404).render('track-order', {
      config,
      tenant: req.tenant,
      order: null,
      error: req.lang === 'el' ? 'Δεν βρέθηκε παραγγελία με αυτά τα στοιχεία.' : 'No order found for these details.'
    });
  }
  return res.render('track-order', { config, tenant: req.tenant, order: normalizeOrderForFulfillment(order), error: null });
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
  console.log('[tenant-admin] render-dashboard', JSON.stringify({
    host: normalizeHost(req.headers.host || ''),
    path: req.originalUrl || req.url,
    tenantId: req.tenant ? req.tenant.id : null,
    mode: req.tenantContext ? req.tenantContext.mode : null
  }));
  try {
    const vm = buildAdminViewModel(req);
    res.render('admin', vm);
  } catch (err) {
    console.error('[tenant-admin] render-dashboard failed:', err && err.stack ? err.stack : String(err));
    res.status(500).send(
      '<!doctype html><html><body style="font-family:system-ui;padding:20px;">' +
      '<h2>Admin dashboard temporarily unavailable</h2>' +
      '<p>An error occurred while loading the admin dashboard. Check server logs for details.</p>' +
      '<p><a href="' + (req.tenantBasePath || '') + '/admin">Retry</a></p>' +
      '</body></html>'
    );
  }
});

app.get('/admin/payments', (req, res) => {
  const extra = {};
  if (req.query.message) extra.message = String(req.query.message);
  if (req.query.error) extra.error = String(req.query.error);
  try {
    res.render('admin-payments', buildAdminPaymentsViewModel(req, extra));
  } catch (err) {
    console.error('[admin-payments] render failed:', err && err.stack ? err.stack : String(err));
    res.status(500).send('<p>Admin payments page temporarily unavailable. <a href="javascript:history.back()">Go back</a></p>');
  }
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
  const rows = [[
    'id', 'type', 'categoryId', 'name_el', 'name_en', 'sku', 'price', 'stock', 'featured', 'imageUrl',
    'galleryImages',
    'variantId', 'variantLabel_el', 'variantLabel_en', 'variantSku', 'variantPrice', 'variantStock', 'variantImageUrl'
  ]];
  products.forEach((p) => {
    const galleryCsv = Array.isArray(p.galleryImages) ? p.galleryImages.join(',') : '';
    const baseRow = [
      p.id || '',
      p.type || 'NORMAL',
      p.categoryId || '',
      resolveTranslatable(p.name, 'el'),
      resolveTranslatable(p.name, 'en'),
      p.sku || '',
      Number(p.price) || 0,
      p.stock === undefined ? '' : Number(p.stock),
      p.featured ? '1' : '0',
      p.imageUrl || '',
      galleryCsv,
      '',
      '',
      '',
      '',
      '',
      '',
      ''
    ];
    rows.push(baseRow);
    if (Array.isArray(p.variants)) {
      p.variants.forEach((v) => {
        rows.push([
          p.id || '',
          p.type || 'NORMAL',
          p.categoryId || '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          v.id || '',
          resolveTranslatable(v.label, 'el'),
          resolveTranslatable(v.label, 'en'),
          v.sku || '',
          v.price === undefined ? '' : Number(v.price),
          v.stock === undefined ? '' : Number(v.stock),
          v.imageUrl || ''
        ]);
      });
    }
  });
  const csv = rows.map((row) => row.map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${req.tenant.id}-products.csv\"`);
  res.send(csv);
});

app.get('/admin/export/orders.csv', (req, res) => {
  const orders = loadTenantOrders(req);
  const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
  const rows = [['id', 'createdAt', 'customerName', 'email', 'city', 'paymentStatus', 'subtotal', 'shippingCost', 'total', 'items']];
  orders.forEach((o) => {
    const items = Array.isArray(o.items)
      ? o.items.map((it) => `${it.name || it.id} x${Number(it.qty) || 1}`).join(' | ')
      : (o.productName || '');
    rows.push([
      o.id || '',
      o.createdAt || '',
      o.customerName || '',
      o.email || '',
      o.city || '',
      o.paymentStatus || '',
      Number(o.subtotal || 0).toFixed(2),
      Number(o.shippingCost || 0).toFixed(2),
      Number(o.total || 0).toFixed(2),
      items
    ]);
  });
  const csv = rows.map((row) => row.map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${req.tenant.id}-orders.csv\"`);
  res.send(csv);
});

app.get('/admin/import/variants-template.csv', (req, res) => {
  const rows = [
    ['productId', 'variantName', 'variantSku', 'priceEUR', 'stock', 'imageUrl', 'videoUrl', 'videoDescription'],
    ['example-product-id', 'Variant name', 'example-sku', '19.90', '5', '/tenants/' + req.tenant.id + '/media/variants/example-product-id/example-sku/example.png', '', '']
  ];
  const esc = (value) => {
    const v = String(value || '');
    if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const csv = rows.map((row) => row.map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${req.tenant.id}-variants-template.csv\"`);
  res.send(csv);
});

app.get('/admin/import/categories-template.csv', (req, res) => {
  const rows = [
    ['id', 'name', 'slug', 'description', 'image', 'visible', 'showInMainNav', 'navOrder'],
    ['fountains', 'Διακοσμητικά Συντριβάνια', 'fountains', 'Ήρεμη ατμόσφαιρα με νερό', '', '1', '1', '1'],
    ['artificial-flowers', 'Τεχνητά Λουλούδια', 'artificial-flowers', 'Floral συνθέσεις για κάθε χώρο', `/tenants/${req.tenant.id}/media/categories/flowers.jpg`, '1', '1', '2']
  ];
  const esc = (value) => {
    const v = String(value || '');
    if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const csv = rows.map((row) => row.map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${req.tenant.id}-categories-template.csv\"`);
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

app.post('/admin/import/products', importUpload.single('file'), async (req, res) => {
  const auth = await verifyAdminAction(req, req.body.password);
  if (!auth.ok) return res.status(401).render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' }));
  if (!req.file) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'No import file uploaded.' }));
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (!['.csv', '.xlsx'].includes(ext)) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Allowed formats: csv, xlsx' }));
  if (ext === '.xlsx') return res.status(400).render('admin', buildAdminViewModel(req, { error: 'XLSX import preview is not enabled in this build yet. Please export/save as CSV.' }));
  const mode = String(req.body.importMode || 'merge').toLowerCase() === 'replace' ? 'replace' : 'merge';
  const rows = parseCsv(req.file.buffer.toString('utf8')).filter((r) => r.some((c) => String(c || '').trim()));
  if (rows.length < 2) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'CSV has no rows.' }));
  const headers = rows[0].map((h) => String(h || '').trim());
  const idx = (name) => headers.indexOf(name);
  const missingCols = ['id', 'type', 'categoryId'].filter((c) => idx(c) === -1);
  if (missingCols.length) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Missing columns: ' + missingCols.join(', ') }));
  const numberOr = (val, fallback) => {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  };
  const errors = [];
  const currentProducts = loadTenantProducts(req);
  const map = new Map((mode === 'replace' ? [] : currentProducts).map((p) => [p.id, { ...p }]));
  let variantsTouched = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const cols = rows[i];
    const get = (k) => String(cols[idx(k)] || '').trim();
    const productId = get('id');
    const variantId = get('variantId');
    if (!productId) { errors.push(`Row ${i + 1}: id is required`); continue; }
    const existing = map.get(productId) || {};
    const next = { ...existing, id: productId };
    const typeRaw = get('type').toUpperCase();
    if (typeRaw) next.type = ['NORMAL', 'PART', 'KIT'].includes(typeRaw) ? typeRaw : 'NORMAL';
    const categoryId = get('categoryId');
    if (categoryId) next.categoryId = categoryId;
    const nameEl = get('name_el');
    const nameEn = get('name_en');
    if (nameEl || nameEn) next.name = nameEn ? { el: nameEl || nameEn, en: nameEn } : nameEl;
    const sku = get('sku');
    if (sku) next.sku = sku;
    const imageUrl = get('imageUrl');
    if (imageUrl) next.imageUrl = imageUrl;
    if (idx('galleryImages') >= 0) {
      next.galleryImages = get('galleryImages')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    const featuredRaw = get('featured');
    if (featuredRaw) next.featured = ['1', 'true', 'yes'].includes(featuredRaw.toLowerCase());
    if (get('price') !== '') next.price = numberOr(get('price'), Number(next.price) || 0);
    if (get('stock') !== '') next.stock = numberOr(get('stock'), Number(next.stock) || 0);
    if (!variantId) {
      if (!next.name) {
        errors.push(`Row ${i + 1}: name_el/name_en required for base product row`);
        continue;
      }
      map.set(productId, next);
      continue;
    }
    next.variants = Array.isArray(next.variants) ? next.variants.slice() : [];
    const vLabelEl = get('variantLabel_el');
    const vLabelEn = get('variantLabel_en');
    const variant = {
      id: variantId,
      label: vLabelEn ? { el: vLabelEl || vLabelEn, en: vLabelEn } : (vLabelEl || variantId),
      sku: get('variantSku') || undefined,
      price: get('variantPrice') === '' ? 0 : numberOr(get('variantPrice'), 0),
      stock: get('variantStock') === '' ? 0 : numberOr(get('variantStock'), 0),
      imageUrl: get('variantImageUrl') || undefined
    };
    const vIdx = next.variants.findIndex((v) => v.id === variantId);
    if (vIdx >= 0) next.variants[vIdx] = { ...next.variants[vIdx], ...variant };
    else next.variants.push(variant);
    variantsTouched += 1;
    map.set(productId, next);
  }
  if (errors.length) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Import errors: ' + errors.join(' | ') }));
  const imported = Array.from(map.values());
  saveTenantProducts(req, imported);
  return res.render('admin', buildAdminViewModel(req, { message: `Imported ${imported.length} products (${variantsTouched} variant rows) in ${mode} mode.` }));
});

app.post('/admin/import/variants', importUpload.single('file'), async (req, res) => {
  const auth = await verifyAdminAction(req, req.body.password);
  if (!auth.ok) return res.status(401).render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' }));
  if (!req.file) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'No variants CSV uploaded.' }));
  const rows = parseCsv(req.file.buffer.toString('utf8')).filter((r) => r.some((c) => String(c || '').trim()));
  if (rows.length < 2) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'CSV has no rows.' }));
  const headers = rows[0].map((h) => String(h || '').trim());
  const idx = (name) => headers.indexOf(name);
  const missing = ['productId', 'variantName', 'variantSku', 'priceEUR', 'stock'].filter((c) => idx(c) === -1);
  if (missing.length) {
    const templateUrl = buildTenantLink(req, '/admin/import/variants-template.csv');
    return res.status(400).render('admin', buildAdminViewModel(req, {
      error: `Missing columns: ${missing.join(', ')}. Download template: ${templateUrl}`
    }));
  }
  const products = loadTenantProducts(req);
  let okRows = 0;
  const failRows = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cols = rows[i];
    const get = (k) => String(cols[idx(k)] || '').trim();
    const productId = get('productId');
    const variantName = get('variantName');
    const variantSku = get('variantSku');
    if (!productId || !variantName) { failRows.push(`Row ${i + 1}: productId + variantName required`); continue; }
    const product = products.find((p) => p.id === productId);
    if (!product) { failRows.push(`Row ${i + 1}: product "${productId}" not found`); continue; }
    product.variants = Array.isArray(product.variants) ? product.variants : [];
    const existingIdx = product.variants.findIndex((v) => (variantSku ? String(v.sku || '') === variantSku : resolveTranslatable(v.label, DEFAULT_CONTENT_LANG) === variantName));
    const price = Number(get('priceEUR'));
    const stock = Number(get('stock'));
    const nextVariant = {
      id: (variantSku || variantName).toLowerCase().replace(/[^a-z0-9\u0370-\u03ff]+/g, '-').replace(/^-+|-+$/g, '') || ('v-' + Date.now()),
      label: variantName,
      sku: variantSku || undefined,
      price: Number.isFinite(price) ? price : 0,
      stock: Number.isFinite(stock) ? stock : 0,
      imageUrl: get('imageUrl') || undefined,
      videoUrl: get('videoUrl') || undefined,
      contentDescription: get('videoDescription') || undefined
    };
    if (existingIdx >= 0) product.variants[existingIdx] = { ...product.variants[existingIdx], ...nextVariant };
    else product.variants.push(nextVariant);
    okRows += 1;
  }
  saveTenantProducts(req, products);
  const msg = `Variants import finished: ${okRows} rows updated.`;
  if (failRows.length) {
    return res.render('admin', buildAdminViewModel(req, { message: msg, error: 'Failed rows: ' + failRows.slice(0, 12).join(' | ') }));
  }
  return res.render('admin', buildAdminViewModel(req, { message: msg }));
});

app.post('/admin/import/categories', importUpload.single('file'), async (req, res) => {
  const auth = await verifyAdminAction(req, req.body.password);
  if (!auth.ok) return res.status(401).render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' }));
  if (!req.file) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Δεν ανέβηκε αρχείο CSV.' }));
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (ext !== '.csv') return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Υποστηρίζεται μόνο CSV αρχείο.' }));

  const rows = parseCsv(req.file.buffer.toString('utf8')).filter((r) => r.some((c) => String(c || '').trim()));
  if (rows.length < 2) return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Το CSV δεν έχει γραμμές δεδομένων.' }));
  const headers = rows[0].map((h) => String(h || '').trim());
  const idx = (name) => headers.indexOf(name);
  const hasColumn = (name) => idx(name) >= 0;
  const get = (cols, name) => {
    const i = idx(name);
    return i >= 0 ? String(cols[i] || '').trim() : '';
  };
  const parseBool = (raw, fallback = null) => {
    const v = String(raw || '').trim().toLowerCase();
    if (!v) return fallback;
    if (['1', 'true', 'yes', 'on', 'y'].includes(v)) return true;
    if (['0', 'false', 'no', 'off', 'n'].includes(v)) return false;
    return fallback;
  };

  const categories = loadTenantCategories(req);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const rowIssues = [];

  for (let i = 1; i < rows.length; i += 1) {
    const cols = rows[i];
    const rawId = get(cols, 'id');
    const rawSlug = get(cols, 'slug');
    const rawName = get(cols, 'name');
    const rawNameEl = get(cols, 'name_el');
    const rawNameEn = get(cols, 'name_en');
    const rawDesc = get(cols, 'description');
    const rawDescEl = get(cols, 'description_el');
    const rawDescEn = get(cols, 'description_en');
    const rawImage = get(cols, 'image');
    const rawVisible = get(cols, 'visible');
    const rawShow = get(cols, 'showInMainNav');
    const rawNavOrder = get(cols, 'navOrder');

    const normalizedId = normalizeSlug(rawId || rawSlug || rawName || rawNameEl || rawNameEn);
    const normalizedSlug = normalizeSlug(rawSlug || rawId || rawName || rawNameEl || rawNameEn);
    const nameValue = rawNameEl || rawNameEn
      ? (rawNameEn ? { el: rawNameEl || rawNameEn, en: rawNameEn } : rawNameEl)
      : rawName;
    const descriptionValue = rawDescEl || rawDescEn
      ? (rawDescEn ? { el: rawDescEl || rawDescEn, en: rawDescEn } : rawDescEl)
      : rawDesc;

    if (!normalizedId && !normalizedSlug && !nameValue) {
      skipped += 1;
      rowIssues.push(`Row ${i + 1}: λείπει id/slug/name.`);
      continue;
    }

    const visible = parseBool(rawVisible, null);
    const showInMainNav = parseBool(rawShow, null);
    const navOrder = rawNavOrder === '' ? null : Number(rawNavOrder);
    const normalizedImage = hasColumn('image') ? normalizeMediaPath(rawImage) : '';

    const existingIndex = categories.findIndex((cat) => (
      (normalizedId && normalizeSlug(cat.id) === normalizedId) ||
      (normalizedSlug && normalizeSlug(cat.slug) === normalizedSlug)
    ));
    const existing = existingIndex >= 0 ? categories[existingIndex] : null;
    if (!existing && !nameValue) {
      skipped += 1;
      rowIssues.push(`Row ${i + 1}: για νέο category απαιτείται name (ή name_el/name_en).`);
      continue;
    }

    const candidate = existing ? { ...existing } : {};
    if (!existing && normalizedId) candidate.id = normalizedId;
    if (normalizedSlug) candidate.slug = normalizedSlug;
    if (nameValue) candidate.name = nameValue;
    if (descriptionValue) candidate.shortDescription = descriptionValue;
    if (hasColumn('image')) {
      if (normalizedImage) candidate.image = normalizedImage;
      else delete candidate.image;
    }
    if (showInMainNav !== null) candidate.showInMainNav = showInMainNav;
    else if (visible !== null) candidate.showInMainNav = visible;
    if (navOrder !== null) {
      if (!Number.isFinite(navOrder)) {
        skipped += 1;
        rowIssues.push(`Row ${i + 1}: μη έγκυρο navOrder.`);
        continue;
      }
      candidate.navOrder = navOrder;
    }

    const normalized = normalizeCategoryRecord(candidate, existingIndex >= 0 ? existingIndex : categories.length);
    if (existing) {
      normalized.id = existing.id; // keep stable id
      let slugCandidate = normalized.slug || existing.slug;
      let suffix = 2;
      while (categories.some((cat, idxCheck) => idxCheck !== existingIndex && normalizeSlug(cat.slug) === normalizeSlug(slugCandidate))) {
        slugCandidate = `${normalized.slug || existing.slug}-${suffix++}`;
      }
      normalized.slug = slugCandidate;
      categories[existingIndex] = normalized;
      updated += 1;
    } else {
      let idCandidate = normalized.id;
      let slugCandidate = normalized.slug;
      let suffix = 2;
      while (categories.some((cat) => normalizeSlug(cat.id) === normalizeSlug(idCandidate))) {
        idCandidate = `${normalized.id}-${suffix++}`;
      }
      suffix = 2;
      while (categories.some((cat) => normalizeSlug(cat.slug) === normalizeSlug(slugCandidate))) {
        slugCandidate = `${normalized.slug}-${suffix++}`;
      }
      categories.push({ ...normalized, id: idCandidate, slug: slugCandidate });
      created += 1;
    }
  }

  saveTenantCategories(req, categories);
  const message = `Category import: ${created} νέα, ${updated} ενημερώσεις, ${skipped} skipped.`;
  if (rowIssues.length) {
    return res.render('admin', buildAdminViewModel(req, {
      message,
      error: `Προβλήματα γραμμών: ${rowIssues.slice(0, 20).join(' | ')}`
    }));
  }
  return res.render('admin', buildAdminViewModel(req, { message }));
});

// Admin orders view
app.get('/admin/orders', (req, res) => {
  try {
    const config = loadTenantConfig(req);
    const allOrders = loadTenantOrders(req);
    const orders = allOrders.slice(-100).reverse().map((order) => normalizeOrderForFulfillment(order));
    const message = typeof req.query.message === 'string' ? String(req.query.message) : null;
    const error = typeof req.query.error === 'string' ? String(req.query.error) : null;
    console.log('[admin-orders] render', JSON.stringify({
      tenantId: req.tenant && req.tenant.id,
      count: orders.length
    }));
    res.render('admin-orders', {
      tenant: req.tenant,
      config,
      orders,
      permissions: getSupportPermissions(req.tenant.supportTier),
      message,
      error
    });
  } catch (err) {
    console.error('[admin-orders] render failed:', err && err.stack ? err.stack : String(err));
    res.status(500).send(
      '<p>Admin orders page temporarily unavailable. Check server logs.</p>' +
      '<p><a href="javascript:history.back()">Go back</a></p>'
    );
  }
});

app.get('/admin/hosting', (req, res) => {
  try {
    const config = loadTenantConfig(req);
    const tenantHosting = req.tenant.hosting && typeof req.tenant.hosting === 'object'
      ? req.tenant.hosting : {};
    const _previewSub = String(req.tenant.previewSubdomain || req.tenant.id || '').trim();
    const hosting = {
      primaryDomain: tenantHosting.primaryDomain || req.tenant.primaryDomain || req.tenant.domain || req.tenant.customDomain || '',
      aliases: (Array.isArray(tenantHosting.aliases) && tenantHosting.aliases.length)
        ? tenantHosting.aliases
        : (Array.isArray(req.tenant.domains) ? req.tenant.domains : []),
      previewHost: tenantHosting.previewHost || (_previewSub ? `${_previewSub}.thonoscommerce.thronoschain.org` : ''),
      domainStatus: tenantHosting.domainStatus || req.tenant.domainStatus || 'pending_dns',
      canonicalToWww: !!tenantHosting.canonicalToWww,
      sslStatus: tenantHosting.sslStatus || 'pending',
      sslProvider: tenantHosting.sslProvider || '',
      sslValidUntil: tenantHosting.sslValidUntil || '',
      dnsVerifiedAt: tenantHosting.dnsVerifiedAt || '',
      lastCheckedAt: tenantHosting.lastCheckedAt || '',
      tenantNotes: tenantHosting.tenantNotes || '',
      logoConfigured: !!(config.logoPath),
      faviconConfigured: !!(config.favicon && config.favicon.path),
      introConfigured: !!(config.homepage && config.homepage.introEnabled),
      introAssetConfigured: !!(config.homepage && config.homepage.introVideoUrl),
      storageUsageMb: Number.isFinite(Number(tenantHosting.storageUsageMb)) ? Number(tenantHosting.storageUsageMb) : null,
      backupStatus: tenantHosting.backupStatus || 'unknown'
    };
    const message = typeof req.query.message === 'string' ? String(req.query.message) : null;
    const error = typeof req.query.error === 'string' ? String(req.query.error) : null;
    res.render('admin-hosting', { tenant: req.tenant, config, hosting, message, error });
  } catch (err) {
    console.error('[admin-hosting] render failed:', err && err.stack ? err.stack : String(err));
    res.status(500).send('<p>Hosting page unavailable. <a href="javascript:history.back()">Go back</a></p>');
  }
});

app.post('/admin/orders/tracking', async (req, res) => {
  const auth = await verifyAdminAction(req, req.body.password);
  if (!auth.ok) {
    return res.redirect(buildTenantLink(req, '/admin/orders', { error: 'Λάθος κωδικός διαχειριστή.' }));
  }

  const orderId = String(req.body.orderId || '').trim();
  const trackingNumber = String(req.body.trackingNumber || '').trim();
  const trackingCarrier = String(req.body.trackingCarrier || '').trim().toLowerCase();
  const fulfillmentStatus = String(req.body.fulfillmentStatus || '').trim().toLowerCase();
  const allowedStatuses = new Set(['pending_payment', 'cod_pending', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'issue']);

  if (!orderId) {
    return res.redirect(buildTenantLink(req, '/admin/orders', { error: 'Order ID is required.' }));
  }

  const orders = loadTenantOrders(req);
  const idx = orders.findIndex((o) => o.id === orderId);
  if (idx < 0) {
    return res.redirect(buildTenantLink(req, '/admin/orders', { error: 'Order not found.' }));
  }

  const now = new Date().toISOString();
  const next = { ...orders[idx] };
  next.trackingNumber = trackingNumber;
  next.trackingCarrier = trackingCarrier;
  next.trackingUrl = deriveTrackingUrl(trackingCarrier, trackingNumber);
  next.fulfillmentStatus = allowedStatuses.has(fulfillmentStatus)
    ? fulfillmentStatus
    : normalizeFulfillmentStatus(next);
  if (next.fulfillmentStatus === 'shipped' && !next.shippedAt) next.shippedAt = now;
  if (next.fulfillmentStatus === 'delivered' && !next.deliveredAt) next.deliveredAt = now;

  orders[idx] = next;
  saveJson(req.tenantPaths.orders, orders);

  if (next.trackingNumber) {
    try {
      await sendTrackingUpdateEmail({
        tenant: req.tenant,
        config: loadTenantConfig(req),
        order: next
      });
    } catch (err) {
      console.error('[admin-orders] tracking-email:failed', err && err.message ? err.message : err);
    }
  }

  console.log('[admin-orders] tracking-save', JSON.stringify({
    tenantId: req.tenant && req.tenant.id,
    orderId,
    trackingNumber: !!trackingNumber,
    trackingCarrier,
    fulfillmentStatus: next.fulfillmentStatus
  }));
  fireVASync(req.tenant.id, 'order.status_changed', {
    order_number: orderId,
    status: next.fulfillmentStatus,
    tracking_number: trackingNumber || undefined,
  });
  return res.redirect(buildTenantLink(req, '/admin/orders', { message: 'Tracking ενημερώθηκε.' }));
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
    homepageIntroEnabled,
    homepageIntroMode,
    homepageIntroTagline,
    homepageIntroVideoUrl,
    homepageIntroPosterUrl,
    homepageBlockOrder,
    homepageBlockHero,
    homepageBlockKits,
    homepageBlockSpare,
    homepageBlockSubscriptions,
    homepageKitsTitle,
    homepageSpareTitle,
    homepageSubscriptionsTitle,
    homepageKitsCtaLabel,
    homepageKitsCtaHref,
    homepageSpareCtaLabel,
    homepageSpareCtaHref,
    homepageSubscriptionsCtaLabel,
    homepageSubscriptionsCtaHref,
    footerContactEmail,
    footerPickupAddress,
    footerFacebookUrl,
    footerInstagramUrl,
    footerTiktokUrl,
    web3Domain,
    logoPath,
    themeMenuBg,
    themeMenuText,
    themeMenuActiveBg,
    themeMenuActiveText,
    themeButtonRadius,
    themePresetId
    ,
    themeHeaderLayout,
    themeAuthPosition,
    themeMenuStyle,
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
    themeHeaderFgHomepage,
    themeHeaderFgProduct,
    themeHeaderFgCategory,
    themeHeaderFgCheckout,
    themeHeaderFgAdmin,
    themeHeaderHeroHomepage,
    themeHeaderHeroProduct,
    themeHeaderHeroCategory,
    themeHeaderHeroCheckout,
    themeCursorImage,
    themeProductThumbAspect,
    themeProductThumbFit,
    themeProductThumbBg,
    themeProductCardHoverEffect,
    themeCardDensity,
    themeProductPreOpenEffect,
    themeFooterTextColor,
    themeKitWizardDisplay,
    themeSpareToolsCardMode,
    themeEnableDiyQuickScenario,
    themeKitWizardSkipRule,
    themeHomeLayoutPreset
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
        buildAdminViewModel(req, {
          error: auth.needsPassword
            ? 'Έληξε το session αποθήκευσης. Βάλε ξανά κωδικό διαχειριστή για να συνεχίσεις.'
            : 'Λάθος κωδικός διαχειριστή.'
        })
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
  config.logoPath = normalizeMediaPath(hasBodyField(req.body, 'logoPath') ? logoPath : config.logoPath) || '/logo.svg';
  config.theme = config.theme || {};
  config.theme.presetId = resolveThemeKeyForTenant(req.tenant, themePresetId || config.theme.presetId || DEFAULT_THEME_KEY);
  config.theme.menuBg = themeMenuBg || config.theme.menuBg || '#111111';
  config.theme.menuText = themeMenuText || config.theme.menuText || '#ffffff';
  config.theme.menuActiveBg =
    themeMenuActiveBg || config.theme.menuActiveBg || '#f06292';
  config.theme.menuActiveText =
    themeMenuActiveText || config.theme.menuActiveText || '#ffffff';
  config.theme.buttonRadius =
    themeButtonRadius || config.theme.buttonRadius || '4px';
  config.theme.headerLayout = themeHeaderLayout || config.theme.headerLayout || 'default';
  config.theme.authPosition = ['left', 'right'].includes(String(themeAuthPosition || '').trim())
    ? String(themeAuthPosition).trim()
    : (config.theme.authPosition || 'right');
  config.theme.menuStyle = ['classic', 'pills', 'compact'].includes(String(themeMenuStyle || '').trim())
    ? String(themeMenuStyle).trim()
    : (config.theme.menuStyle || 'classic');
  config.theme.heroStyle = themeHeroStyle || config.theme.heroStyle || 'soft';
  config.theme.categoryMenuStyle = themeCategoryMenuStyle || config.theme.categoryMenuStyle || 'image_label';
  config.theme.cardStyle = themeCardStyle || config.theme.cardStyle || 'soft';
  config.theme.sectionSpacing = themeSectionSpacing || config.theme.sectionSpacing || 'normal';
  config.theme.bannerVisible = readCheckbox(req.body, 'themeBannerVisible', config.theme.bannerVisible);
  config.theme.previewBadgeStyle = themePreviewBadgeStyle || config.theme.previewBadgeStyle || 'soft';
  config.theme.cursorEffect = readCheckbox(req.body, 'themeCursorEffect', config.theme.cursorEffect);
  const rawCursorImage = (themeCursorImage || config.theme.cursorImage || '').trim();
  config.theme.cursorImage = (/^\//.test(rawCursorImage) ? rawCursorImage : '');
  config.theme.brandingMode = themeBrandingMode || config.theme.brandingMode || 'logo_name';
  config.theme.logoDisplayMode = themeLogoDisplayMode || config.theme.logoDisplayMode || 'contain';
  config.theme.logoBgMode = themeLogoBgMode || config.theme.logoBgMode || 'auto';
  config.theme.logoPadding = Math.max(0, Math.min(24, Number(themeLogoPadding) || Number(config.theme.logoPadding) || 6));
  config.theme.logoRadius = Math.max(0, Math.min(36, Number(themeLogoRadius) || Number(config.theme.logoRadius) || 10));
  const normalizedLogoShadow = String(themeLogoShadow || config.theme.logoShadow || 'soft').trim();
  config.theme.logoShadow = ['none', 'soft', 'floating'].includes(normalizedLogoShadow) ? normalizedLogoShadow : 'soft';
  config.theme.logoMaxHeight = Math.max(28, Math.min(140, Number(themeLogoMaxHeight) || Number(config.theme.logoMaxHeight) || 88));
  const _fgModes = ['hidden', 'badge-left', 'badge-right', 'centered-small', 'normal'];
  const _heroModes = ['off', 'centered-background', 'full-width-background'];
  const _pick = (val, allowed, fallback) => allowed.includes(String(val || '').trim()) ? String(val).trim() : fallback;
  config.theme.headerFgHomepage = _pick(themeHeaderFgHomepage, _fgModes, config.theme.headerFgHomepage || 'hidden');
  config.theme.headerFgProduct = _pick(themeHeaderFgProduct, _fgModes, config.theme.headerFgProduct || 'badge-right');
  config.theme.headerFgCategory = _pick(themeHeaderFgCategory, _fgModes, config.theme.headerFgCategory || 'badge-right');
  config.theme.headerFgCheckout = _pick(themeHeaderFgCheckout, _fgModes, config.theme.headerFgCheckout || 'badge-left');
  config.theme.headerFgAdmin = _pick(themeHeaderFgAdmin, _fgModes, config.theme.headerFgAdmin || 'normal');
  config.theme.headerHeroHomepage = _pick(themeHeaderHeroHomepage, _heroModes, config.theme.headerHeroHomepage || 'centered-background');
  config.theme.headerHeroProduct = _pick(themeHeaderHeroProduct, _heroModes, config.theme.headerHeroProduct || 'centered-background');
  config.theme.headerHeroCategory = _pick(themeHeaderHeroCategory, _heroModes, config.theme.headerHeroCategory || 'off');
  config.theme.headerHeroCheckout = _pick(themeHeaderHeroCheckout, _heroModes, config.theme.headerHeroCheckout || 'off');
  config.theme.productThumbAspect = ['4:3', '1:1', '3:4'].includes(String(themeProductThumbAspect || '')) ? String(themeProductThumbAspect) : (config.theme.productThumbAspect || '4:3');
  config.theme.productThumbFit = ['cover', 'contain'].includes(String(themeProductThumbFit || '')) ? String(themeProductThumbFit) : (config.theme.productThumbFit || 'cover');
  const rawThumbBg = String(themeProductThumbBg || config.theme.productThumbBg || '#111111').trim();
  config.theme.productThumbBg = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(rawThumbBg) ? rawThumbBg : '#111111';
  config.theme.productCardHoverEffect = ['none', 'lift', 'glow'].includes(String(themeProductCardHoverEffect || '')) ? String(themeProductCardHoverEffect) : (config.theme.productCardHoverEffect || 'lift');
  config.theme.cardDensity = ['compact', 'normal', 'spacious'].includes(String(themeCardDensity || '')) ? String(themeCardDensity) : (config.theme.cardDensity || 'normal');
  config.theme.productPreOpenEffect = ['none', 'exposure'].includes(String(themeProductPreOpenEffect || '')) ? String(themeProductPreOpenEffect) : (config.theme.productPreOpenEffect || 'none');
  const rawFooterTextColor = String(themeFooterTextColor || config.theme.footerTextColor || '#6b7280').trim();
  config.theme.footerTextColor = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(rawFooterTextColor) ? rawFooterTextColor : '#6b7280';
  config.theme.kitWizardDisplay = ['sequential', 'cinematic'].includes(String(themeKitWizardDisplay || ''))
    ? String(themeKitWizardDisplay)
    : (config.theme.kitWizardDisplay || 'sequential');
  config.theme.spareToolsCardMode = ['prominent', 'compact'].includes(String(themeSpareToolsCardMode || ''))
    ? String(themeSpareToolsCardMode)
    : (config.theme.spareToolsCardMode || 'prominent');
  config.theme.enableDiyQuickScenario = readCheckbox(req.body, 'themeEnableDiyQuickScenario', !!config.theme.enableDiyQuickScenario);
  config.theme.kitWizardSkipRule = ['none', 'optional', 'all'].includes(String(themeKitWizardSkipRule || ''))
    ? String(themeKitWizardSkipRule)
    : (config.theme.kitWizardSkipRule || 'none');
  config.theme.homeLayoutPreset = ['split', 'stacked'].includes(String(themeHomeLayoutPreset || ''))
    ? String(themeHomeLayoutPreset)
    : (config.theme.homeLayoutPreset || 'split');
  config.homepage = config.homepage || {};
  if (hasBodyField(req.body, 'homepageHeroImage')) {
    config.homepage.heroImage = normalizeMediaPath(homepageHeroImage);
  }
  const hasLegacyFeaturedIds = hasBodyField(req.body, 'homepageFeaturedIds');
  const hasFeaturedPrimaryInputs =
    hasBodyField(req.body, 'homepageFeaturedPrimary') ||
    hasBodyField(req.body, 'homepageFeaturedPrimary1') ||
    hasBodyField(req.body, 'homepageFeaturedPrimary2');
  if (hasLegacyFeaturedIds || hasFeaturedPrimaryInputs) {
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
    config.homepage.featuredIds = legacyFeaturedIds;
  }
  if (hasBodyField(req.body, 'homepageFeaturedSecondaryId')) {
    config.homepage.featuredSecondaryId = String(homepageFeaturedSecondaryId || '').trim();
  }
  config.homepage.secondaryCard = config.homepage.secondaryCard || {};
  if (
    hasBodyField(req.body, 'homepageSecondaryTitle') ||
    CONTENT_LANGS.some((lang) => hasBodyField(req.body, `homepageSecondaryTitle_${lang}`))
  ) {
    config.homepage.secondaryCard.title = buildTranslatableFromBody(
      req.body,
      'homepageSecondaryTitle',
      config.homepage.secondaryCard.title || ''
    );
  }
  if (
    hasBodyField(req.body, 'homepageSecondaryText') ||
    CONTENT_LANGS.some((lang) => hasBodyField(req.body, `homepageSecondaryText_${lang}`))
  ) {
    config.homepage.secondaryCard.text = buildTranslatableFromBody(
      req.body,
      'homepageSecondaryText',
      config.homepage.secondaryCard.text || ''
    );
  }
  if (hasBodyField(req.body, 'homepageSecondaryLink')) {
    config.homepage.secondaryCard.link = String(homepageSecondaryLink || '').trim();
  }
  if (hasBodyField(req.body, 'homepageSecondaryImage')) {
    config.homepage.secondaryCard.image = normalizeMediaPath(homepageSecondaryImage);
  }
  config.homepage.showSubscriptionsCard = readCheckbox(req.body, 'homepageShowSubscriptionsCard', config.homepage.showSubscriptionsCard);
  config.homepage.introEnabled = readCheckbox(req.body, 'homepageIntroEnabled', config.homepage.introEnabled);
  if (hasBodyField(req.body, 'homepageIntroMode')) {
    const _validModes = ['basic', 'assembly', 'video'];
    const _m = String(homepageIntroMode || 'basic').trim().toLowerCase();
    config.homepage.introMode = _validModes.includes(_m) ? _m : 'basic';
  }
  if (hasBodyField(req.body, 'homepageIntroTagline')) config.homepage.introTagline = String(homepageIntroTagline || '').trim();
  if (hasBodyField(req.body, 'homepageIntroVideoUrl')) config.homepage.introVideoUrl = normalizeMediaPath(homepageIntroVideoUrl, { allowAbsoluteUrl: true });
  if (hasBodyField(req.body, 'homepageIntroPosterUrl')) config.homepage.introPosterUrl = normalizeMediaPath(homepageIntroPosterUrl, { allowAbsoluteUrl: true });
  if (hasBodyField(req.body, 'homepageBlockOrder')) {
    const parsedOrder = String(homepageBlockOrder || '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    const validKeys = ['hero', 'kits', 'spare', 'subscriptions'];
    const normalized = parsedOrder.filter((k) => validKeys.includes(k));
    const merged = normalized.concat(validKeys.filter((k) => !normalized.includes(k)));
    config.homepage.blockOrder = merged;
  }
  config.homepage.blockVisibility = config.homepage.blockVisibility || {};
  config.homepage.blockVisibility.hero = readCheckbox(req.body, 'homepageBlockHero', config.homepage.blockVisibility.hero !== false);
  config.homepage.blockVisibility.kits = readCheckbox(req.body, 'homepageBlockKits', config.homepage.blockVisibility.kits !== false);
  config.homepage.blockVisibility.spare = readCheckbox(req.body, 'homepageBlockSpare', config.homepage.blockVisibility.spare !== false);
  config.homepage.blockVisibility.subscriptions = readCheckbox(req.body, 'homepageBlockSubscriptions', config.homepage.blockVisibility.subscriptions !== false);
  config.homepage.blockContent = config.homepage.blockContent || {};
  if (hasBodyField(req.body, 'homepageKitsTitle')) config.homepage.blockContent.kitsTitle = String(homepageKitsTitle || '').trim();
  if (hasBodyField(req.body, 'homepageSpareTitle')) config.homepage.blockContent.spareTitle = String(homepageSpareTitle || '').trim();
  if (hasBodyField(req.body, 'homepageSubscriptionsTitle')) config.homepage.blockContent.subscriptionsTitle = String(homepageSubscriptionsTitle || '').trim();
  if (hasBodyField(req.body, 'homepageKitsCtaLabel')) config.homepage.blockContent.kitsCtaLabel = String(homepageKitsCtaLabel || '').trim();
  if (hasBodyField(req.body, 'homepageKitsCtaHref')) config.homepage.blockContent.kitsCtaHref = String(homepageKitsCtaHref || '').trim();
  if (hasBodyField(req.body, 'homepageSpareCtaLabel')) config.homepage.blockContent.spareCtaLabel = String(homepageSpareCtaLabel || '').trim();
  if (hasBodyField(req.body, 'homepageSpareCtaHref')) config.homepage.blockContent.spareCtaHref = String(homepageSpareCtaHref || '').trim();
  if (hasBodyField(req.body, 'homepageSubscriptionsCtaLabel')) config.homepage.blockContent.subscriptionsCtaLabel = String(homepageSubscriptionsCtaLabel || '').trim();
  if (hasBodyField(req.body, 'homepageSubscriptionsCtaHref')) config.homepage.blockContent.subscriptionsCtaHref = String(homepageSubscriptionsCtaHref || '').trim();
  config.footer = config.footer || {};
  config.footer.contactEmail = (footerContactEmail || config.footer.contactEmail || '').trim();
  config.footer.pickupAddress = (footerPickupAddress || config.footer.pickupAddress || '').trim();
  config.footer.facebookUrl = (footerFacebookUrl || config.footer.facebookUrl || '').trim();
  config.footer.instagramUrl = (footerInstagramUrl || config.footer.instagramUrl || '').trim();
  config.footer.tiktokUrl = (footerTiktokUrl || config.footer.tiktokUrl || '').trim();

  saveTenantConfig(req, config);

  res.render(
    'admin',
    buildAdminViewModel(req, { message: 'Οι ρυθμίσεις αποθηκεύτηκαν.' })
  );
});

app.post('/admin/coupons', async (req, res) => {
  const { password, code, type, value, minSubtotal, active } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditSettings) {
    return res.status(403).render('admin', buildAdminViewModel(req, { error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή κουπονιών.' }));
  }
  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
    return res.status(401).render('admin', buildAdminViewModel(req, { error: 'Λάθος κωδικός διαχειριστή.' }));
  }
  const normalizedCode = normalizeCouponCode(code || '');
  if (!normalizedCode) {
    return res.status(400).render('admin', buildAdminViewModel(req, { error: 'Δώστε έγκυρο coupon code.' }));
  }
  const couponType = String(type || 'percent').toLowerCase() === 'fixed' ? 'fixed' : 'percent';
  const couponValue = Math.max(0, Number(value) || 0);
  const couponMinSubtotal = Math.max(0, Number(minSubtotal) || 0);
  const config = loadTenantConfig(req);
  const coupons = Array.isArray(config.coupons) ? config.coupons.slice() : [];
  const idx = coupons.findIndex((c) => normalizeCouponCode(c.code) === normalizedCode);
  const nextCoupon = {
    code: normalizedCode,
    type: couponType,
    value: couponValue,
    minSubtotal: couponMinSubtotal,
    active: String(active || '1') !== '0'
  };
  if (idx >= 0) coupons[idx] = Object.assign({}, coupons[idx], nextCoupon);
  else coupons.push(nextCoupon);
  config.coupons = coupons;
  saveTenantConfig(req, config);
  return res.render('admin', buildAdminViewModel(req, { message: `Το κουπόνι ${normalizedCode} αποθηκεύτηκε.` }));
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
  // New notifications config contract — platform SMTP, tenant branding only.
  if (!config.notifications) config.notifications = {};
  config.notifications.enabled          = req.body.emailNotificationsEnabled === 'on';
  config.notifications.notificationEmail = (req.body.notificationEmail || '').trim();
  config.notifications.replyToEmail     = (req.body.replyToEmail || '').trim();
  config.notifications.supportEmail     = (req.body.supportEmail || '').trim();
  // Top-level legacy fields still read by email-sending code
  config.notificationCcCustomer  = req.body.notificationCcCustomer === 'on';
  config.notificationFromName    = (req.body.notificationFromName || '').trim();
  // Keep legacy notificationEmails in sync for backward compatibility
  config.notificationEmails = config.notifications.notificationEmail
    ? [config.notifications.notificationEmail]
    : [];
  config.notificationWebhookUrl    = (req.body.notificationWebhookUrl || '').trim();
  config.notificationWebhookSecret = (req.body.notificationWebhookSecret || '').trim();
  saveTenantConfig(req, config);

  return res.render('admin', buildAdminViewModel(req, { message: 'Οι ρυθμίσεις ειδοποιήσεων αποθηκεύτηκαν.' }));
});

/* ── Virtual Assistant settings ─────────────────────────────────────────── */
app.post('/admin/assistant', async (req, res) => {
  const { password } = req.body;
  const permissions = getSupportPermissions(req.tenant.supportTier);
  if (!permissions.canEditSettings) {
    return res.status(403).render('admin', buildAdminViewModel(req, {
      error: 'Το πακέτο υποστήριξης δεν επιτρέπει αλλαγή ρυθμίσεων βοηθού.'
    }));
  }
  const auth = await verifyAdminAction(req, password);
  if (!auth.ok) {
    return res.status(401).render('admin', buildAdminViewModel(req, {
      error: 'Λάθος κωδικός διαχειριστή.'
    }));
  }

  const config = loadTenantConfig(req);
  if (!config.assistant) config.assistant = {};

  const b = req.body;
  const _validModes = ['disabled', 'customer', 'merchant', 'both'];
  const _validLangs = ['el', 'en', 'auto'];
  const _validTones = ['friendly', 'professional', 'technical'];
  const _str = (v) => String(v || '').trim().slice(0, 2000); /* cap free-text at 2000 chars */

  config.assistant.vaEnabled          = parseBooleanInput(b.vaEnabled, false);
  config.assistant.vaMode             = _validModes.includes(b.vaMode)     ? b.vaMode     : 'disabled';
  config.assistant.vaLanguage         = _validLangs.includes(b.vaLanguage) ? b.vaLanguage : 'auto';
  config.assistant.vaTone             = _validTones.includes(b.vaTone)     ? b.vaTone     : 'friendly';
  config.assistant.vaBrandVoice       = _str(b.vaBrandVoice);
  config.assistant.vaStoreInstructions= _str(b.vaStoreInstructions);
  config.assistant.vaProductGuidance  = _str(b.vaProductGuidance);
  config.assistant.vaCustomerSupport  = _str(b.vaCustomerSupport);
  config.assistant.vaAvoidTopics      = _str(b.vaAvoidTopics);
  config.assistant.vaMerchantGoals    = _str(b.vaMerchantGoals);

  saveTenantConfig(req, config);
  return res.render('admin', buildAdminViewModel(req, { message: 'Οι ρυθμίσεις του βοηθού αποθηκεύτηκαν.' }));
});

app.get('/admin/assistant-panel', (req, res) => {
  const config = loadTenantConfig(req);
  const assistant = (config && config.assistant) || {};
  res.render('admin-assistant-panel', {
    tenant: req.tenant,
    config,
    assistant,
    withTenantLink: (pathName, q) => withTenantLink(req, pathName, q),
    lang: normalizeLang((req.query && req.query.lang) || req.cookies.lang || 'el')
  });
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
  config.paypalEmail = (req.body.paypalEmail || '').trim();
  const stripeEnabled = req.body.enableStripe === 'on';
  const paypalEnabled = req.body.enablePaypal === 'on';
  const existing = Array.isArray(config.paymentOptions) ? config.paymentOptions.slice() : [];
  const nonGateway = existing.filter((opt) => !['stripe', 'paypal'].includes(String(opt.id || '').toLowerCase()) && !['stripe', 'paypal'].includes(String(opt.type || '').toLowerCase()));
  const rebuilt = nonGateway.slice();
  if (stripeEnabled) {
    rebuilt.push({ id: 'stripe', label: 'Stripe (Card)', type: 'stripe', gatewaySurchargePercent: 0 });
  }
  if (paypalEnabled) {
    rebuilt.push({ id: 'paypal', label: 'PayPal', type: 'paypal', gatewaySurchargePercent: 0 });
  }
  config.paymentOptions = rebuilt;
  if (Array.isArray(config.shippingOptions)) {
    config.shippingOptions.forEach((ship) => {
      const existingAllowed = Array.isArray(ship.allowedPaymentMethods) ? ship.allowedPaymentMethods : [];
      let allowed = existingAllowed.filter((id) => !['stripe', 'paypal'].includes(String(id).toLowerCase()));
      if (stripeEnabled) allowed.push('stripe');
      if (paypalEnabled) allowed.push('paypal');
      ship.allowedPaymentMethods = Array.from(new Set(allowed));
    });
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
  const normalizedCategoryImage = normalizeMediaPath(image);
  if (normalizedCategoryImage) newCat.image = normalizedCategoryImage;
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
    const normalizedCategoryImage = normalizeMediaPath(image);
    if (normalizedCategoryImage) categories[idx].image = normalizedCategoryImage;
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
      categoryId: p.categoryId || '',
      variants: Array.isArray(p.variants) ? p.variants.map((v) => ({
        id: v.id,
        label: resolveTranslatable(v.label, DEFAULT_CONTENT_LANG) || v.id,
        price: Number(v.price) || 0,
        stock: v.stock === undefined ? 0 : Number(v.stock),
        imageUrl: v.imageUrl || '',
        videoUrl: v.videoUrl || ''
      })) : []
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
      const normalizedProduct = normalizeProductRecord(p);
      p.imageUrl = normalizedProduct.imageUrl;
      p.galleryImages = normalizedProduct.galleryImages;
      p.gallery = normalizedProduct.gallery;
      if (typeof p.active !== 'boolean') p.active = true;
    });
    saveTenantProducts(req, parsed);
    // Sync each product to the VA in the background
    parsed.forEach((p) => {
      const name = resolveTranslatable(p.name, DEFAULT_CONTENT_LANG);
      fireVASync(req.tenant.id, 'product.updated', {
        sku: p.id,
        name,
        description: resolveTranslatable(p.description || '', DEFAULT_CONTENT_LANG),
        category: p.categoryId || '',
        price: Number(p.price) || 0,
        stock: Number(p.stock) || 0,
        active: p.active !== false,
        low_stock_threshold: Number(p.lowStockThreshold) || 5,
        imageUrl: p.imageUrl || '',
      });
    });
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

app.post('/admin/products/image-upload', async (req, res) => {
  productsImageUpload.single('imageFile')(req, res, async (uploadErr) => {
    if (uploadErr) {
      console.error('[upload] products:image failed', uploadErr && uploadErr.message ? uploadErr.message : uploadErr);
      return res.status(400).json({ ok: false, error: 'Product image upload failed. Please check file type/size.' });
    }
    const permissions = getSupportPermissions(req.tenant.supportTier);
    if (!permissions.canUploadMedia || !permissions.canEditProducts) {
      return res.status(403).json({ ok: false, error: 'Upload not allowed for this support tier.' });
    }
    const auth = await verifyAdminAction(req, req.body.password);
    if (!auth.ok) return res.status(401).json({ ok: false, error: 'Invalid admin password.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    const url = `/tenants/${req.tenant.id}/media/products/${req.file.filename}`;
    return res.json({ ok: true, url });
  });
});

app.post('/admin/variants/image-upload', async (req, res) => {
  variantImageUpload.single('variantImage')(req, res, async (uploadErr) => {
    if (uploadErr) {
      console.error('[upload] variants:image failed', uploadErr && uploadErr.message ? uploadErr.message : uploadErr);
      return res.status(400).json({ ok: false, error: 'Variant image upload failed. Please check file type/size.' });
    }
    const permissions = getSupportPermissions(req.tenant.supportTier);
    if (!permissions.canUploadMedia || !permissions.canEditProducts) {
      return res.status(403).json({ ok: false, error: 'Upload not allowed for this support tier.' });
    }
    const auth = await verifyAdminAction(req, req.body.password);
    if (!auth.ok) return res.status(401).json({ ok: false, error: 'Invalid admin password.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No image uploaded.' });
    const { productId, variantSku } = getVariantMediaMeta(req);
    const url = `/tenants/${req.tenant.id}/media/variants/${productId}/${variantSku}/${req.file.filename}`;
    return res.json({ ok: true, url });
  });
});

app.post('/admin/variants/video-upload', async (req, res) => {
  variantVideoUpload.single('variantVideo')(req, res, async (uploadErr) => {
    if (uploadErr) {
      console.error('[upload] variants:video failed', uploadErr && uploadErr.message ? uploadErr.message : uploadErr);
      return res.status(400).json({ ok: false, error: 'Variant video upload failed. Please check file type/size.' });
    }
    const permissions = getSupportPermissions(req.tenant.supportTier);
    if (!permissions.canUploadMedia || !permissions.canEditProducts) {
      return res.status(403).json({ ok: false, error: 'Upload not allowed for this support tier.' });
    }
    const auth = await verifyAdminAction(req, req.body.password);
    if (!auth.ok) return res.status(401).json({ ok: false, error: 'Invalid admin password.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No video uploaded.' });
    const { productId, variantSku } = getVariantMediaMeta(req);
    const url = `/tenants/${req.tenant.id}/media/variants/${productId}/${variantSku}/${req.file.filename}`;
    return res.json({ ok: true, url });
  });
});

app.post(
  '/admin/homepage/banner-upload',
  bannerUpload.single('bannerFile'),
  async (req, res) => {
    const permissions = getSupportPermissions(req.tenant.supportTier);
    if (!permissions.canUploadMedia || !permissions.canEditSettings) {
      return res.status(403).json({ ok: false, error: 'Upload not allowed for this support tier.' });
    }
    const auth = await verifyAdminAction(req, req.body.password);
    if (!auth.ok) return res.status(401).json({ ok: false, error: 'Invalid admin password.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No banner uploaded.' });
    const url = `/tenants/${req.tenant.id}/media/banners/${req.file.filename}`;
    return res.json({ ok: true, url });
  }
);

app.post(
  '/admin/parts/image-upload',
  partsUpload.single('partFile'),
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

app.post(
  '/admin/theme/cursor-upload',
  cursorUpload.single('cursorFile'),
  async (req, res) => {
    const permissions = getSupportPermissions(req.tenant.supportTier);
    if (!permissions.canUploadMedia || !permissions.canEditSettings) {
      return res.status(403).json({ ok: false, error: 'Upload not allowed for this support tier.' });
    }
    const auth = await verifyAdminAction(req, req.body.password);
    if (!auth.ok) return res.status(401).json({ ok: false, error: 'Session expired. Please enter admin password.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No cursor file uploaded.' });
    const url = `/tenants/${req.tenant.id}/media/cursors/${req.file.filename}`;
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
app.post('/admin/favicon', async (req, res) => {
  favUpload.single('favicon')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const uploadMsg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? 'Το favicon είναι πολύ μεγάλο (μέγιστο 512KB).'
        : 'Μη έγκυρο favicon αρχείο. Επιτρέπονται PNG/JPG/ICO/SVG.';
      return res.redirect(`${buildTenantLink(req, '/admin', { error: uploadMsg })}#tab-upload`);
    }
    const password = req.body.password;
    const auth = await verifyAdminAction(req, password);
    if (!auth.ok) {
      return res.redirect(`${buildTenantLink(req, '/admin', { error: 'Λάθος κωδικός διαχειριστή' })}#tab-upload`);
    }
    if (!req.file) {
      return res.redirect(`${buildTenantLink(req, '/admin', { error: 'Δεν επιλέχθηκε αρχείο' })}#tab-upload`);
    }
    const mime = String(req.file.mimetype || '').toLowerCase();
    const extByMime = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/x-icon': '.ico',
      'image/vnd.microsoft.icon': '.ico',
      'image/svg+xml': '.svg'
    };
    const safeExt = extByMime[mime] || path.extname(String(req.file.originalname || '')).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.ico', '.svg'].includes(safeExt)) {
      return res.redirect(`${buildTenantLink(req, '/admin', { error: 'Μη υποστηριζόμενο favicon format. Επιτρέπονται PNG/JPG/ICO/SVG.' })}#tab-upload`);
    }
    const faviconDir = path.join(req.tenantPaths.media, 'favicon');
    ensureDir(faviconDir);
    const targetName = `favicon-${Date.now()}${safeExt === '.jpeg' ? '.jpg' : safeExt}`;
    const targetPath = path.join(faviconDir, targetName);
    fs.writeFileSync(targetPath, req.file.buffer);
    const config = loadTenantConfig(req);
    const oldPath = String(config && config.favicon && config.favicon.path || '').trim();
    if (oldPath.startsWith(`/tenants/${req.tenant.id}/media/favicon/`)) {
      const oldFile = path.join(req.tenantPaths.media, 'favicon', path.basename(oldPath));
      if (fs.existsSync(oldFile) && oldFile !== targetPath) {
        try { fs.unlinkSync(oldFile); } catch (_) {}
      }
    }
    config.favicon = {
      path: `/tenants/${req.tenant.id}/media/favicon/${targetName}`,
      mime: mime || 'image/png',
      updatedAt: Date.now()
    };
    saveTenantConfig(req, config);
    return res.redirect(`${buildTenantLink(req, '/admin', { message: 'Favicon αποθηκεύτηκε' })}#tab-upload`);
  });
});

// Favicon delete
app.post('/admin/favicon/delete', async (req, res) => {
  const auth = await verifyAdminAction(req, req.body.password);
  if (!auth.ok) {
    return res.redirect(`${buildTenantLink(req, '/admin', { error: 'Λάθος κωδικός διαχειριστή' })}#tab-upload`);
  }
  const config = loadTenantConfig(req);
  const existingPath = String(config && config.favicon && config.favicon.path || '').trim();
  if (existingPath.startsWith(`/tenants/${req.tenant.id}/media/favicon/`)) {
    const fullPath = path.join(req.tenantPaths.media, 'favicon', path.basename(existingPath));
    if (fs.existsSync(fullPath)) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }
  }
  if (fs.existsSync(req.tenantPaths.favicon)) fs.unlinkSync(req.tenantPaths.favicon); // legacy fallback cleanup
  config.favicon = { path: '', mime: '', updatedAt: 0 };
  saveTenantConfig(req, config);
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
        // Notify platform team about new paid subscription (uses platform SMTP transport)
        try {
          const transporter = buildTransport();
          if (transporter) {
            await transporter.sendMail({
              from: `"Thronos Commerce" <${process.env.THRC_SMTP_FROM || process.env.THRC_SMTP_USER}>`,
              to: process.env.SUPPORT_EMAIL || 'support@thronoschain.org',
              subject: `Νέα πληρωμένη συνδρομή — ${entry.brand} (${entry.packageId})`,
              text: `Νέος πελάτης πλήρωσε:\n\nΌνομα: ${entry.name}\nEmail: ${entry.email}\nΤηλ: ${entry.phone}\nBrand: ${entry.brand}\nDomain: ${entry.domain || '–'}\nΠακέτο: ${entry.packageId} — ${amount}\nSession: ${session_id}\n\nΕνεργοποιήστε τον tenant στον root admin.`
            });
          }
        } catch (_) {}
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

  // Email to platform support team (uses platform SMTP transport)
  try {
    const transporter = buildTransport();
    if (transporter) {
      const tConfig = loadTenantConfig(req);
      await transporter.sendMail({
        from:    `"Thronos Support" <${process.env.THRC_SMTP_FROM || process.env.THRC_SMTP_USER}>`,
        to:      process.env.SUPPORT_EMAIL || 'support@thronoschain.org',
        subject: `[Ticket #${ticket.id}] [${req.tenant.id}] ${ticket.subject}`,
        text:    `Tenant: ${req.tenant.id} (${resolveTranslatable(tConfig.storeName, DEFAULT_CONTENT_LANG) || ''})\nΚατηγορία: ${ticket.category}\n\n${ticket.body}\n\n---\nΑπαντήστε σε αυτό το email για να απαντήσετε στον tenant.`
      });
    }
  } catch (_) {}

  res.render('admin', buildAdminViewModel(req, { message: '✓ Το αίτημα υποστήριξης στάλθηκε. Θα επικοινωνήσουμε σύντομα.' }));
});

// Root admin: add reply to ticket
app.post('/root/tickets/reply', async (req, res) => {
  const { password, tenantId, ticketId, replyText } = req.body;
  if (!verifyRootPassword(password)) { setRootFlash(req, { error: 'Λάθος root κωδικός.' }); return res.redirect('/root/tickets'); }

  const tenantPaths = tenantPaths(tenantId);
  const tickets = loadJson(tenantPaths.tickets, []);
  const tIdx    = tickets.findIndex((t) => t.id === ticketId);
  if (tIdx >= 0) {
    tickets[tIdx].replies.push({ from: 'support', text: replyText.trim(), createdAt: new Date().toISOString() });
    tickets[tIdx].status = 'replied';
    saveJson(tenantPaths.tickets, tickets);
  }

  setRootFlash(req, { message: 'Η απάντηση στο ticket στάλθηκε.' });
  res.redirect('/root/tickets');
});

// Root admin: close ticket
app.post('/root/tickets/close', async (req, res) => {
  const { password, tenantId, ticketId } = req.body;
  if (!verifyRootPassword(password)) { setRootFlash(req, { error: 'Λάθος root κωδικός.' }); return res.redirect('/root/tickets'); }

  const tenantPaths = tenantPaths(tenantId);
  const tickets = loadJson(tenantPaths.tickets, []);
  const tIdx    = tickets.findIndex((t) => t.id === ticketId);
  if (tIdx >= 0) { tickets[tIdx].status = 'resolved'; saveJson(tenantPaths.tickets, tickets); }
  setRootFlash(req, { message: 'Το ticket έκλεισε.' });
  res.redirect('/root/tickets');
});

// ─── Root Admin: Tenants Management ──────────────────────────────────────────

const SUPPORT_TIERS = ['SELF_SERVICE', 'MANAGEMENT_START', 'FULL_OPS_START', 'DIGITAL_STARTER', 'DIGITAL_PRO'];

function buildRootViewModel(extra, req) {
  const tenants = loadTenantsRegistry();
  const themeGovernance = loadThemeGovernance();
  const themeCatalog = listThemeCatalog();
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
  const referralLedgerRaw = loadReferralLedger();
  const settlementLedgerRaw = loadSettlementLedger();
  const q = (req && req.query) ? req.query : {};
  const tenantFilter = String(q.tenantId || '').trim();
  const referralCodeFilter = String(q.referralCode || '').trim();
  const referralStatusFilter = String(q.refStatus || '').trim();
  const settlementStatusFilter = String(q.stStatus || '').trim();
  const paymentMethodFilter = String(q.paymentMethod || '').trim();

  const referralLedger = referralLedgerRaw.filter((row) => {
    if (tenantFilter && row.tenantId !== tenantFilter) return false;
    if (referralCodeFilter && row.referralCode !== referralCodeFilter) return false;
    if (referralStatusFilter && row.status !== referralStatusFilter) return false;
    return true;
  });
  const settlementLedger = settlementLedgerRaw.filter((row) => {
    if (tenantFilter && row.tenantId !== tenantFilter) return false;
    if (paymentMethodFilter && row.paymentMethod !== paymentMethodFilter) return false;
    if (settlementStatusFilter && row.status !== settlementStatusFilter) return false;
    return true;
  });
  const referralTotalsByCode = referralLedger.reduce((acc, row) => {
    const key = row.referralCode || 'unknown';
    if (!acc[key]) acc[key] = { pending: 0, approved: 0, paid: 0, orders: 0 };
    acc[key].orders += 1;
    if (row.status === 'paid') acc[key].paid += Number(row.commissionAmount || 0);
    else if (row.status === 'approved') acc[key].approved += Number(row.commissionAmount || 0);
    else if (row.status === 'pending') acc[key].pending += Number(row.commissionAmount || 0);
    return acc;
  }, {});
  const settlementTotalsByTenant = settlementLedger.reduce((acc, row) => {
    const key = row.tenantId || 'unknown';
    if (!acc[key]) acc[key] = { pendingPayable: 0, pendingReceivable: 0, settled: 0 };
    if (row.status === 'settled') {
      acc[key].settled += Number(row.netSettlementAmount || 0);
    } else if (row.status === 'pending' || row.status === 'approved' || row.status === 'partially_settled') {
      if (row.settlementDirection === 'payable_to_tenant') acc[key].pendingPayable += Number(row.netSettlementAmount || 0);
      if (row.settlementDirection === 'receivable_from_tenant') acc[key].pendingReceivable += Number(row.netSettlementAmount || 0);
    }
    return acc;
  }, {});
  const pendingReferralPayouts = referralLedger
    .filter((row) => row.status === 'pending' || row.status === 'approved')
    .reduce((sum, row) => sum + Number(row.commissionAmount || 0), 0);
  const pendingTenantPayables = settlementLedger
    .filter((row) => (row.status === 'pending' || row.status === 'approved' || row.status === 'partially_settled') && row.settlementDirection === 'payable_to_tenant')
    .reduce((sum, row) => sum + Number(row.netSettlementAmount || 0), 0);
  const pendingTenantReceivables = settlementLedger
    .filter((row) => (row.status === 'pending' || row.status === 'approved' || row.status === 'partially_settled') && row.settlementDirection === 'receivable_from_tenant')
    .reduce((sum, row) => sum + Number(row.netSettlementAmount || 0), 0);
  const unresolvedFinanceCount = referralLedger.filter((r) => ['pending', 'approved', 'disputed'].includes(r.status)).length
    + settlementLedger.filter((r) => ['pending', 'approved', 'partially_settled', 'disputed'].includes(r.status)).length;

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
    themeGovernance,
    themeCatalog,
    themeTemplates: listThemeTemplates(),
    tenantPaymentConfigs,
    refAccounts,
    refEarnings: refEarnings.slice(-200).reverse(),
    referralLedger: referralLedger.slice().reverse().slice(0, 400),
    settlementLedger: settlementLedger.slice().reverse().slice(0, 400),
    referralTotalsByCode,
    settlementTotalsByTenant,
    pendingReferralPayouts: +pendingReferralPayouts.toFixed(2),
    pendingTenantPayables: +pendingTenantPayables.toFixed(2),
    pendingTenantReceivables: +pendingTenantReceivables.toFixed(2),
    unresolvedFinanceCount,
    pendingByCode,
    allTickets: allTickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    financeFilters: { tenantFilter, referralCodeFilter, referralStatusFilter, settlementStatusFilter, paymentMethodFilter },
    getSubscriptionInfo,
    PACKAGE_PRICES,
    message: null,
    error: null,
    ...(extra || {})
  };
}

// ── Session flash for root admin ──────────────────────────────────────────────
function setRootFlash(req, data) { req.session._rootFlash = data; }
function popRootFlash(req) { const f = req.session._rootFlash || {}; req.session._rootFlash = null; return f; }

// ── Nav badge counts (open tickets + unresolved finance) ──────────────────────
function getRootNavCounts() {
  const ts = loadTenantsRegistry();
  let openTicketCount = 0;
  ts.forEach((t) => {
    try { openTicketCount += loadJson(tenantPaths(t.id).tickets, []).filter((tk) => tk.status !== 'resolved').length; } catch (_) {}
  });
  const refL = loadReferralLedger();
  const stL  = loadSettlementLedger();
  const unresolvedFinanceCount =
    refL.filter((r) => ['pending', 'approved', 'disputed'].includes(r.status)).length +
    stL.filter((r)  => ['pending', 'approved', 'partially_settled', 'disputed'].includes(r.status)).length;
  return { openTicketCount, unresolvedFinanceCount };
}

// ── Page-specific model builders ──────────────────────────────────────────────
function buildDashboardViewModel(req) {
  const flash   = popRootFlash(req);
  const tenants = loadTenantsRegistry();
  const navCounts = getRootNavCounts();

  const activeSubs = tenants.filter((t) => t.active && t.subscriptionExpiry && new Date(t.subscriptionExpiry) > new Date()).length;
  const expiringSoon = tenants.filter((t) => {
    if (!t.subscriptionExpiry) return false;
    const d = (new Date(t.subscriptionExpiry) - new Date()) / 86400000;
    return d >= 0 && d <= 14;
  }).length;
  const recentTickets = [];
  tenants.forEach((t) => {
    try { loadJson(tenantPaths(t.id).tickets, []).filter((tk) => tk.status !== 'resolved').forEach((tk) => recentTickets.push({ ...tk, _tenantId: t.id })); } catch (_) {}
  });
  recentTickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const pendingReferralAmount = loadReferralLedger()
    .filter((r) => r.status === 'pending' || r.status === 'approved')
    .reduce((s, r) => s + Number(r.commissionAmount || 0), 0);

  return {
    page: 'dashboard', ...navCounts,
    tenants, tenantCount: tenants.length, activeTenantCount: tenants.filter((t) => t.active).length,
    activeSubs, expiringSoon,
    recentTickets: recentTickets.slice(0, 5),
    pendingReferralAmount: +pendingReferralAmount.toFixed(2),
    getSubscriptionInfo,
    message: flash.message || null, error: flash.error || null
  };
}

function buildTenantsViewModel(req, extra) {
  const flash   = popRootFlash(req);
  const tenants = loadTenantsRegistry();
  const tenantPaymentConfigs = {};
  tenants.forEach((t) => {
    try {
      const cfgPath = path.join(TENANTS_DIR, t.id, 'config.json');
      tenantPaymentConfigs[t.id] = fs.existsSync(cfgPath) ? (JSON.parse(fs.readFileSync(cfgPath, 'utf8')).paymentOptions || []) : [];
    } catch (_) { tenantPaymentConfigs[t.id] = []; }
  });
  return {
    page: 'tenants', ...getRootNavCounts(),
    tenants, themeGovernance: loadThemeGovernance(), tenantPaymentConfigs,
    getSubscriptionInfo, SUPPORT_TIERS, PACKAGE_PRICES,
    message: (extra && extra.message) || flash.message || null,
    error:   (extra && extra.error)   || flash.error   || null
  };
}

function buildThemesViewModel(req, extra) {
  const flash = popRootFlash(req);
  return {
    page: 'themes', ...getRootNavCounts(),
    tenants: loadTenantsRegistry(),
    themeGovernance: loadThemeGovernance(), themeCatalog: listThemeCatalog(), themeTemplates: listThemeTemplates(),
    message: (extra && extra.message) || flash.message || null,
    error:   (extra && extra.error)   || flash.error   || null
  };
}

function buildFinanceViewModel(req, extra) {
  const flash = popRootFlash(req);
  const q = (req && req.query) ? req.query : {};
  const tenantFilter = String(q.tenantId || '').trim();
  const referralCodeFilter = String(q.referralCode || '').trim();
  const referralStatusFilter = String(q.refStatus || '').trim();
  const settlementStatusFilter = String(q.stStatus || '').trim();
  const paymentMethodFilter = String(q.paymentMethod || '').trim();

  const refEarnings = loadReferralEarnings();
  const refLedgerRaw = loadReferralLedger();
  const stLedgerRaw  = loadSettlementLedger();
  const referralLedger = refLedgerRaw.filter((r) => {
    if (tenantFilter && r.tenantId !== tenantFilter) return false;
    if (referralCodeFilter && r.referralCode !== referralCodeFilter) return false;
    if (referralStatusFilter && r.status !== referralStatusFilter) return false;
    return true;
  });
  const settlementLedger = stLedgerRaw.filter((r) => {
    if (tenantFilter && r.tenantId !== tenantFilter) return false;
    if (paymentMethodFilter && r.paymentMethod !== paymentMethodFilter) return false;
    if (settlementStatusFilter && r.status !== settlementStatusFilter) return false;
    return true;
  });
  const referralTotalsByCode = referralLedger.reduce((acc, r) => {
    const k = r.referralCode || 'unknown';
    if (!acc[k]) acc[k] = { pending: 0, approved: 0, paid: 0, orders: 0 };
    acc[k].orders += 1;
    if (r.status === 'paid')     acc[k].paid     += Number(r.commissionAmount || 0);
    else if (r.status === 'approved') acc[k].approved += Number(r.commissionAmount || 0);
    else if (r.status === 'pending')  acc[k].pending  += Number(r.commissionAmount || 0);
    return acc;
  }, {});
  const settlementTotalsByTenant = settlementLedger.reduce((acc, r) => {
    const k = r.tenantId || 'unknown';
    if (!acc[k]) acc[k] = { pendingPayable: 0, pendingReceivable: 0, settled: 0 };
    if (r.status === 'settled') acc[k].settled += Number(r.netSettlementAmount || 0);
    else if (['pending', 'approved', 'partially_settled'].includes(r.status)) {
      if (r.settlementDirection === 'payable_to_tenant')     acc[k].pendingPayable    += Number(r.netSettlementAmount || 0);
      if (r.settlementDirection === 'receivable_from_tenant') acc[k].pendingReceivable += Number(r.netSettlementAmount || 0);
    }
    return acc;
  }, {});
  const pendingReferralPayouts   = referralLedger.filter((r) => r.status === 'pending' || r.status === 'approved').reduce((s, r) => s + Number(r.commissionAmount || 0), 0);
  const pendingTenantPayables    = settlementLedger.filter((r) => ['pending', 'approved', 'partially_settled'].includes(r.status) && r.settlementDirection === 'payable_to_tenant').reduce((s, r) => s + Number(r.netSettlementAmount || 0), 0);
  const pendingTenantReceivables = settlementLedger.filter((r) => ['pending', 'approved', 'partially_settled'].includes(r.status) && r.settlementDirection === 'receivable_from_tenant').reduce((s, r) => s + Number(r.netSettlementAmount || 0), 0);
  const pendingByCode = {};
  refEarnings.filter((e) => e.status === 'pending').forEach((e) => {
    if (!pendingByCode[e.refCode]) pendingByCode[e.refCode] = { total: 0, rows: [] };
    pendingByCode[e.refCode].total = +(pendingByCode[e.refCode].total + e.amountFiat).toFixed(2);
    pendingByCode[e.refCode].rows.push(e);
  });
  return {
    page: 'finance', ...getRootNavCounts(),
    tenants: loadTenantsRegistry(),
    refAccounts: loadReferralAccounts(), refEarnings: refEarnings.slice(-200).reverse(),
    referralLedger: referralLedger.slice().reverse().slice(0, 400),
    settlementLedger: settlementLedger.slice().reverse().slice(0, 400),
    referralTotalsByCode, settlementTotalsByTenant,
    pendingReferralPayouts: +pendingReferralPayouts.toFixed(2),
    pendingTenantPayables:  +pendingTenantPayables.toFixed(2),
    pendingTenantReceivables: +pendingTenantReceivables.toFixed(2),
    pendingByCode,
    financeFilters: { tenantFilter, referralCodeFilter, referralStatusFilter, settlementStatusFilter, paymentMethodFilter },
    message: (extra && extra.message) || flash.message || null,
    error:   (extra && extra.error)   || flash.error   || null
  };
}

function buildTicketsViewModel(req) {
  const flash = popRootFlash(req);
  const tenants = loadTenantsRegistry();
  const allTickets = [], resolvedTickets = [];
  tenants.forEach((t) => {
    try {
      loadJson(tenantPaths(t.id).tickets, []).forEach((tk) => {
        if (tk.status === 'resolved') resolvedTickets.push({ ...tk, _tenantId: t.id });
        else allTickets.push({ ...tk, _tenantId: t.id });
      });
    } catch (_) {}
  });
  allTickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  resolvedTickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return {
    page: 'tickets', ...getRootNavCounts(),
    allTickets, resolvedTickets: resolvedTickets.slice(0, 20),
    message: flash.message || null, error: flash.error || null
  };
}

app.get('/root',          (req, res) => { if (!req.session.rootAdmin) return res.redirect('/root/login'); res.redirect('/root/dashboard'); });
app.get('/root/dashboard', requireRootAdmin, (req, res) => res.render('root-dashboard', buildDashboardViewModel(req)));
app.get('/root/tenants',   requireRootAdmin, (req, res) => res.render('root-tenants',   buildTenantsViewModel(req)));
app.get('/root/themes',    requireRootAdmin, (req, res) => res.render('root-themes',    buildThemesViewModel(req)));
app.get('/root/finance',   requireRootAdmin, (req, res) => res.render('root-finance',   buildFinanceViewModel(req)));
app.get('/root/tickets',   requireRootAdmin, (req, res) => res.render('root-tickets',   buildTicketsViewModel(req)));

app.get('/root/hosting', requireRootAdmin, (req, res) => {
  const flash = popRootFlash(req);
  const rows = _buildHostingRows(loadTenantsRegistry());
  const navCounts = getRootNavCounts();
  const unresolvedCount = rows.filter((row) => row.issueFlag || row.domainStatus !== 'active' || row.sslStatus !== 'active').length;
  const vaUrlMissing = !(process.env.THRONOS_ASSISTANT_URL || process.env.ASSISTANT_API_URL);
  console.log('[root-hosting] render', JSON.stringify({ rows: rows.length, unresolvedCount, vaUrlMissing }));
  res.render('root-hosting', { page: 'hosting', ...navCounts, rows, unresolvedCount, vaUrlMissing, message: flash.message || null, error: flash.error || null });
});

app.get('/root/login', (req, res) => {
  if (req.session.rootAdmin) return res.redirect('/root/dashboard');
  res.render('root-login', { error: null });
});

app.post('/root/login', (req, res) => {
  const { password } = req.body;
  if (!verifyRootPassword(password)) {
    return res.status(401).render('root-login', { error: 'Invalid root password.' });
  }
  req.session.rootAdmin = { authenticatedAt: new Date().toISOString() };
  res.redirect('/root/dashboard');
});

app.get('/root/logout', (req, res) => {
  req.session.rootAdmin = null;
  res.redirect('/root/login');
});

app.post('/root/tenants/create', async (req, res) => {
  const {
    rootPassword, id, domain, supportTier, adminPasswordPlain, templateId, refCode, refPercent,
    primaryDomain, domains, previewSubdomain, domainStatus, canonicalToWww, allowedThemeKeys
  } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants', buildTenantsViewModel(req, { error: 'Λάθος root κωδικός.' }));
  }

  const cleanId = (id || '').trim();
  if (!cleanId || !/^[a-z0-9_-]+$/i.test(cleanId)) {
    return res.status(400).render('root-tenants', buildTenantsViewModel(req, { error: 'Το tenant id είναι υποχρεωτικό και επιτρέπονται μόνο a-z, 0-9, _ και -.' }));
  }

  if (!adminPasswordPlain) {
    return res.status(400).render('root-tenants', buildTenantsViewModel(req, { error: 'Ο κωδικός admin είναι υποχρεωτικός.' }));
  }

  const tenants = loadTenantsRegistry();
  if (tenants.some((t) => t.id === cleanId)) {
    return res.status(400).render('root-tenants', buildTenantsViewModel(req, { error: `Υπάρχει ήδη tenant με id "${cleanId}".` }));
  }

  const adminPasswordHash = await bcrypt.hash(adminPasswordPlain, 10);
  const resolvedTier = SUPPORT_TIERS.includes(supportTier) ? supportTier : 'SELF_SERVICE';

  const cleanRefCode = (refCode || '').trim();
  const normalizedDomains = normalizeTenantDomainInputs({
    domain,
    primaryDomain,
    domains,
    previewSubdomain,
    fallbackPreviewSubdomain: cleanId
  });
  const allowedDomainStatuses = ['pending_dns', 'ssl_validating', 'active', 'failed'];
  const parsedAllowedThemeKeys = normalizeThemeKeys(String(allowedThemeKeys || '').split(','), loadThemeGovernance().availableThemeKeys);
  const newTenant = {
    id: cleanId,
    domain: normalizedDomains.domain,
    primaryDomain: normalizedDomains.primaryDomain,
    domains: normalizedDomains.domains,
    previewSubdomain: normalizedDomains.previewSubdomain,
    domainStatus: allowedDomainStatuses.includes(String(domainStatus || '').trim()) ? String(domainStatus).trim() : 'pending_dns',
    canonicalToWww: parseBooleanInput(canonicalToWww, false),
    allowedThemeKeys: parsedAllowedThemeKeys,
    supportTier: resolvedTier,
    poweredByMode: 'disabled',
    allowPoweredBy: false,
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

  setRootFlash(req, { message: `Ο tenant "${cleanId}" δημιουργήθηκε επιτυχώς.` });
  res.redirect('/root/tenants');
});

app.post('/root/templates/create', (req, res) => {
  const { rootPassword, tenantId, templateId, templateName } = req.body;
  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-themes', buildThemesViewModel(req, { error: 'Λάθος root κωδικός.' }));
  }
  const tenant = findTenantById((tenantId || '').trim());
  if (!tenant) {
    return res.status(404).render('root-themes', buildThemesViewModel(req, { error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }
  const cleanTemplateId = sanitizeTemplateId(templateId);
  if (!cleanTemplateId) {
    return res.status(400).render('root-themes', buildThemesViewModel(req, { error: 'Δώστε έγκυρο template id (a-z, 0-9, -, _).' }));
  }
  const tpl = saveTemplateFromTenant(cleanTemplateId, tenant.id, templateName);
  setRootFlash(req, { message: `Template "${tpl.id}" αποθηκεύτηκε.` });
  return res.redirect('/root/themes');
});

app.post('/root/themes/update', (req, res) => {
  const { rootPassword, availableThemeKeys } = req.body;
  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-themes', buildThemesViewModel(req, { error: 'Λάθος root κωδικός.' }));
  }
  const parsedKeys = String(availableThemeKeys || '').split(',');
  const nextAvailable = normalizeThemeKeys(parsedKeys, DEFAULT_AVAILABLE_THEME_KEYS);
  saveThemeGovernance({ availableThemeKeys: nextAvailable });
  const tenants = loadTenantsRegistry();
  const constrained = tenants.map((tenant) => {
    const allowed = normalizeThemeKeys(tenant.allowedThemeKeys, nextAvailable).filter((key) => nextAvailable.includes(key));
    return Object.assign({}, tenant, { allowedThemeKeys: allowed });
  });
  saveTenantsRegistry(constrained);
  setRootFlash(req, { message: 'Τα διαθέσιμα themes ενημερώθηκαν.' });
  return res.redirect('/root/themes');
});

app.post('/root/tenants/update', (req, res) => {
  const {
    rootPassword, tenantId, domain, supportTier, active, allowPoweredBy,
    primaryDomain, domains, previewSubdomain, domainStatus, canonicalToWww, allowedThemeKeys
  } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants', buildTenantsViewModel(req, { error: 'Λάθος root κωδικός.' }));
  }

  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex((t) => t.id === tenantId);
  if (idx === -1) {
    return res.status(404).render('root-tenants', buildTenantsViewModel(req, { error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }

  if (domain !== undefined || primaryDomain !== undefined || domains !== undefined || previewSubdomain !== undefined) {
    const normalizedDomains = normalizeTenantDomainInputs({
      domain: domain !== undefined ? domain : tenants[idx].domain,
      primaryDomain: primaryDomain !== undefined ? primaryDomain : tenants[idx].primaryDomain,
      domains: domains !== undefined ? domains : (Array.isArray(tenants[idx].domains) ? tenants[idx].domains.join(',') : ''),
      previewSubdomain: previewSubdomain !== undefined ? previewSubdomain : tenants[idx].previewSubdomain,
      fallbackPreviewSubdomain: tenants[idx].id
    });
    tenants[idx].domain = normalizedDomains.domain;
    tenants[idx].primaryDomain = normalizedDomains.primaryDomain;
    tenants[idx].domains = normalizedDomains.domains;
    tenants[idx].previewSubdomain = normalizedDomains.previewSubdomain;
  }
  if (domainStatus !== undefined) {
    const normalizedStatus = String(domainStatus || '').trim();
    const allowedDomainStatuses = ['pending_dns', 'ssl_validating', 'active', 'failed'];
    tenants[idx].domainStatus = allowedDomainStatuses.includes(normalizedStatus) ? normalizedStatus : (tenants[idx].domainStatus || 'pending_dns');
  }
  if (canonicalToWww !== undefined) tenants[idx].canonicalToWww = parseBooleanInput(canonicalToWww, tenants[idx].canonicalToWww === true);
  if (allowedThemeKeys !== undefined) {
    const governance = loadThemeGovernance();
    tenants[idx].allowedThemeKeys = normalizeThemeKeys(String(allowedThemeKeys || '').split(','), governance.availableThemeKeys)
      .filter((key) => governance.availableThemeKeys.includes(key));
  }
  if (supportTier && SUPPORT_TIERS.includes(supportTier)) tenants[idx].supportTier = supportTier;
  tenants[idx].active = parseBooleanInput(active, tenants[idx].active !== false);
  const requestedAllowPoweredBy = parseBooleanInput(allowPoweredBy, undefined);
  const { poweredByMode } = req.body;
  if (poweredByMode !== undefined) {
    const allowedModes = new Set(['always', 'free_only', 'disabled']);
    tenants[idx].poweredByMode = allowedModes.has(String(poweredByMode || '').trim()) ? String(poweredByMode).trim() : 'disabled';
  } else if (requestedAllowPoweredBy !== undefined) {
    tenants[idx].poweredByMode = requestedAllowPoweredBy ? 'always' : 'disabled';
  }
  const poweredByCfg = getTenantPoweredByConfig(tenants[idx]);
  tenants[idx].poweredByMode = poweredByCfg.poweredByMode;
  tenants[idx].allowPoweredBy = poweredByCfg.allowPoweredBy;

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

  setRootFlash(req, { message: `Ο tenant "${tenantId}" ενημερώθηκε.` });
  res.redirect('/root/tenants');
});

app.post('/root/tenants/reset-admin-password', async (req, res) => {
  const { rootPassword, tenantId, newPassword } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants', buildTenantsViewModel(req, { error: 'Λάθος root κωδικός.' }));
  }

  if (!newPassword) {
    return res.status(400).render('root-tenants', buildTenantsViewModel(req, { error: 'Ο νέος κωδικός είναι υποχρεωτικός.' }));
  }

  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex((t) => t.id === tenantId);
  if (idx === -1) {
    return res.status(404).render('root-tenants', buildTenantsViewModel(req, { error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }

  tenants[idx].adminPasswordHash = await bcrypt.hash(newPassword, 10);
  saveTenantsRegistry(tenants);
  console.log(`[Root Admin] Reset admin password for tenant: ${tenantId}`);

  setRootFlash(req, { message: `Ο κωδικός admin για τον tenant "${tenantId}" ενημερώθηκε.` });
  res.redirect('/root/tenants');
});

// Root: update gateway surcharge for a tenant's payment options
app.post('/root/tenants/payment-config', (req, res) => {
  const { rootPassword, tenantId } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-tenants', buildTenantsViewModel(req, { error: 'Λάθος root κωδικός.' }));
  }

  const tenants = loadTenantsRegistry();
  const tenant = tenants.find((t) => t.id === tenantId);
  if (!tenant) {
    return res.status(404).render('root-tenants', buildTenantsViewModel(req, { error: `Tenant "${tenantId}" δεν βρέθηκε.` }));
  }

  const cfgPath = path.join(TENANTS_DIR, tenantId, 'config.json');
  const config = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  (config.paymentOptions || []).forEach((opt, i) => {
    const surcharge = req.body[`surcharge_${i}`];
    if (surcharge !== undefined) opt.gatewaySurchargePercent = parseFloat(surcharge) || 0;
  });
  saveJson(cfgPath, config);
  console.log(`[Root Admin] Updated payment surcharges for tenant: ${tenantId}`);

  setRootFlash(req, { message: `Τα surcharges για τον tenant "${tenantId}" αποθηκεύτηκαν.` });
  res.redirect('/root/tenants');
});

// ── Stripe webhook → referral earnings ───────────────────────────────────────
app.post('/stripe/webhook', async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'] || '';
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    let event;

    // Verify signature when secret is configured
    if (secret) {
      try {
        // Simple HMAC-SHA256 verification (Stripe-compatible payload structure)
        const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
        const parts = sig.split(',').reduce((acc, p) => {
          const [k, v] = p.split('='); acc[k] = v; return acc;
        }, {});
        const ts = parts.t;
        const expected = crypto.createHmac('sha256', secret)
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

    const obj = event.data && event.data.object;
    if (!obj) return res.json({ received: true });

    // Resolve tenantId from metadata
    const tenantId = (obj.metadata && obj.metadata.tenantId) || '';
    const externalId = obj.id || '';
    const amountRaw = obj.amount_total || obj.amount_paid || 0;  // Stripe amount in cents
    const amountFiat = +(amountRaw / 100).toFixed(2);
    const currency = (obj.currency || 'eur').toUpperCase();

    if (!tenantId || amountFiat <= 0) return res.json({ received: true });

    const tenants = loadTenantsRegistry();
    const tenant = tenants.find((t) => t.id === tenantId);
    if (!tenant || !tenant.referral || !tenant.referral.code) return res.json({ received: true });

    const refCode = tenant.referral.code;
    const percent = typeof tenant.referral.percent === 'number' ? tenant.referral.percent : 0.1;
    const commission = +(amountFiat * percent).toFixed(2);
    const source = event.type === 'invoice.payment_succeeded' ? 'stripe_subscription' : 'stripe_checkout';

    // Write earning row (idempotent for webhook retries)
    const earnings = loadReferralEarnings();
    const alreadyRecorded = earnings.some((e) =>
      e && e.tenantId === tenantId && e.externalId === externalId && e.source === source
    );
    if (alreadyRecorded) return res.json({ received: true });

    const earningId = `re_${Date.now().toString(36)}`;
    earnings.push({
      id:          earningId,
      tenantId,
      refCode,
      amountFiat:  commission,
      currency,
      source,
      externalId,
      status:      'pending',
      createdAt:   new Date().toISOString(),
      paidAt:      null,
      paidVia:     null,
      txId:        null
    });
    saveReferralEarnings(earnings);

    // Update account totals
    const accounts = ensureReferralAccount(refCode, percent);
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
      source,
      externalId,
      payoutMode: 'offchain_fiat',
      meta: { stripeEvent: event.type }
    }).catch(() => {});

    return res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook] Unexpected error:', err.message);
    return res.status(200).json({ received: true });
  }
});

// ── Root: referral config per tenant ─────────────────────────────────────────
app.post('/root/tenants/referral', async (req, res) => {
  const { rootPassword, tenantId, refCode, refPercent } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    setRootFlash(req, { error: 'Λάθος root κωδικός.' }); return res.redirect('/root/finance');
  }

  const tenants = loadTenantsRegistry();
  const idx     = tenants.findIndex((t) => t.id === tenantId);
  if (idx === -1) {
    setRootFlash(req, { error: `Tenant "${tenantId}" δεν βρέθηκε.` }); return res.redirect('/root/finance');
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
  setRootFlash(req, { message: `Referral για τον tenant "${tenantId}" αποθηκεύτηκε.` });
  res.redirect('/root/finance');
});

// ── Root: referral account fiat method update ─────────────────────────────────
app.post('/root/referral/account', (req, res) => {
  const { rootPassword, code, payoutMode, iban, holder, wallet } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    setRootFlash(req, { error: 'Λάθος root κωδικός.' }); return res.redirect('/root/finance');
  }
  const accounts = loadReferralAccounts();
  if (!accounts[code]) {
    setRootFlash(req, { error: `Referral account "${code}" δεν βρέθηκε.` }); return res.redirect('/root/finance');
  }
  accounts[code].payoutMode  = payoutMode || 'offchain_fiat';
  accounts[code].wallet      = (wallet || '').trim() || null;
  accounts[code].fiatMethod  = { type: 'bank', iban: (iban || '').trim(), holder: (holder || '').trim() };
  saveReferralAccounts(accounts);

  setRootFlash(req, { message: `Account "${code}" ενημερώθηκε.` });
  res.redirect('/root/finance');
});

// ── Root: mark earning(s) as paid ────────────────────────────────────────────
app.post('/root/referral/mark-paid', (req, res) => {
  const { rootPassword, earningId, refCode, paidVia, txId } = req.body;

  if (!verifyRootPassword(rootPassword)) {
    setRootFlash(req, { error: 'Λάθος root κωδικός.' }); return res.redirect('/root/finance');
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

  setRootFlash(req, { message: `Πληρωμή ${totalPaid.toFixed(2)} € καταγράφηκε.` });
  res.redirect('/root/finance');
});

app.post('/root/finance/referrals/update', (req, res) => {
  const { rootPassword, ledgerId, status, notes } = req.body;
  if (!verifyRootPassword(rootPassword)) {
    setRootFlash(req, { error: 'Λάθος root κωδικός.' }); return res.redirect('/root/finance');
  }
  const allowed = new Set(['pending', 'approved', 'paid', 'cancelled', 'disputed']);
  const nextStatus = String(status || '').trim().toLowerCase();
  if (!allowed.has(nextStatus)) {
    setRootFlash(req, { error: 'Μη έγκυρο referral status.' }); return res.redirect('/root/finance');
  }
  const ledger = loadReferralLedger();
  const idx = ledger.findIndex((row) => row.id === String(ledgerId || '').trim());
  if (idx < 0) {
    setRootFlash(req, { error: 'Referral ledger entry δεν βρέθηκε.' }); return res.redirect('/root/finance');
  }
  ledger[idx] = {
    ...ledger[idx],
    status: nextStatus,
    notes: String(notes || '').trim(),
    updatedAt: new Date().toISOString()
  };
  saveReferralLedger(ledger);
  console.log('[finance] referral-ledger:update', JSON.stringify({
    ledgerId: ledger[idx].id, tenantId: ledger[idx].tenantId, orderId: ledger[idx].orderId, status: nextStatus
  }));
  setRootFlash(req, { message: 'Referral ledger ενημερώθηκε.' });
  return res.redirect('/root/finance');
});

app.post('/root/finance/settlements/update', (req, res) => {
  const { rootPassword, ledgerId, status, notes } = req.body;
  if (!verifyRootPassword(rootPassword)) {
    setRootFlash(req, { error: 'Λάθος root κωδικός.' }); return res.redirect('/root/finance');
  }
  const allowed = new Set(['pending', 'approved', 'partially_settled', 'settled', 'cancelled', 'disputed']);
  const nextStatus = String(status || '').trim().toLowerCase();
  if (!allowed.has(nextStatus)) {
    setRootFlash(req, { error: 'Μη έγκυρο settlement status.' }); return res.redirect('/root/finance');
  }
  const ledger = loadSettlementLedger();
  const idx = ledger.findIndex((row) => row.id === String(ledgerId || '').trim());
  if (idx < 0) {
    setRootFlash(req, { error: 'Settlement entry δεν βρέθηκε.' }); return res.redirect('/root/finance');
  }
  ledger[idx] = {
    ...ledger[idx],
    status: nextStatus,
    notes: String(notes || '').trim(),
    updatedAt: new Date().toISOString()
  };
  saveSettlementLedger(ledger);
  console.log('[finance] settlement-ledger:update', JSON.stringify({
    ledgerId: ledger[idx].id, tenantId: ledger[idx].tenantId, orderId: ledger[idx].orderId, status: nextStatus
  }));
  setRootFlash(req, { message: 'Settlement ledger ενημερώθηκε.' });
  return res.redirect('/root/finance');
});

app.post('/root/hosting/update', (req, res) => {
  const { rootPassword, tenantId, section } = req.body;
  if (!verifyRootPassword(rootPassword)) {
    return res.status(401).render('root-hosting', { rows: [], unresolvedCount: 0, message: null, error: 'Λάθος root κωδικός.' });
  }
  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex((t) => t.id === String(tenantId || '').trim());
  if (idx < 0) {
    return res.status(404).render('root-hosting', { rows: [], unresolvedCount: 0, message: null, error: 'Tenant δεν βρέθηκε.' });
  }

  const sec = String(section || 'dns').trim();

  if (sec === 'dns' || sec === 'general') {
    const allowedDomain = new Set(['pending_dns', 'ssl_validating', 'active', 'failed']);
    const { domainStatus, dnsVerifiedAt } = req.body;
    const nextDomainStatus = allowedDomain.has(String(domainStatus || '').trim()) ? String(domainStatus).trim() : 'pending_dns';
    tenants[idx].hosting = {
      ...(tenants[idx].hosting || {}),
      domainStatus: nextDomainStatus,
      dnsVerifiedAt: String(dnsVerifiedAt || '').trim()
    };
    tenants[idx].domainStatus = nextDomainStatus;
  }

  if (sec === 'ssl') {
    const allowedSsl = new Set(['pending', 'validating', 'active', 'failed']);
    const { sslStatus, sslProvider, sslValidUntil } = req.body;
    const nextSslStatus = allowedSsl.has(String(sslStatus || '').trim()) ? String(sslStatus).trim() : 'pending';
    tenants[idx].hosting = {
      ...(tenants[idx].hosting || {}),
      sslManualOverride: {
        enabled: true,
        sslStatus: nextSslStatus,
        sslProvider: String(sslProvider || '').trim(),
        sslValidUntil: String(sslValidUntil || '').trim(),
        updatedAt: new Date().toISOString()
      }
    };
  }

  if (sec === 'footer') {
    const { poweredByMode, poweredByLabel, poweredByHref } = req.body;
    const allowedModes = new Set(['always', 'free_only', 'disabled']);
    const nextMode = allowedModes.has(String(poweredByMode || '').trim()) ? String(poweredByMode).trim() : 'disabled';
    tenants[idx].poweredByMode = nextMode;
    tenants[idx].poweredByLabel = String(poweredByLabel || '').trim().slice(0, 120);
    tenants[idx].poweredByHref = String(poweredByHref || '').trim().slice(0, 500);
    const poweredByCfg = getTenantPoweredByConfig(tenants[idx]);
    tenants[idx].poweredByMode = poweredByCfg.poweredByMode;
    tenants[idx].allowPoweredBy = poweredByCfg.allowPoweredBy;
  }

  if (sec === 'mail') {
    const { mailProvider, mxRecords, spfRecord, dkimRecords, dmarcRecord } = req.body;
    if (!tenants[idx].mailHosting) tenants[idx].mailHosting = {};
    tenants[idx].mailHosting = {
      mailProvider: String(mailProvider || '').trim() || null,
      mxRecords: String(mxRecords || '').split(',').map(s => s.trim()).filter(Boolean),
      spfRecord: String(spfRecord || '').trim() || null,
      dkimRecords: String(dkimRecords || '').split(',').map(s => s.trim()).filter(Boolean),
      dmarcRecord: String(dmarcRecord || '').trim() || null
    };
  }

  if (sec === 'web3') {
    const { web3Enabled, web3Host, ipfsGateway, dnslinkTxt } = req.body;
    if (!tenants[idx].web3Config) tenants[idx].web3Config = {};
    tenants[idx].web3Config = {
      web3Enabled: String(web3Enabled || '') === '1',
      web3Host: String(web3Host || '').trim() || null,
      ipfsGateway: String(ipfsGateway || '').trim() || null,
      dnslinkTxt: String(dnslinkTxt || '').trim() || null
    };
  }

  if (sec === 'advanced') {
    const allowedBackup = new Set(['unknown', 'healthy', 'warning', 'failed']);
    const { issueFlag, internalNotes, tenantNotes, backupStatus } = req.body;
    const nextBackupStatus = allowedBackup.has(String(backupStatus || '').trim()) ? String(backupStatus).trim() : 'unknown';
    tenants[idx].hosting = {
      ...(tenants[idx].hosting || {}),
      issueFlag: String(issueFlag || '') === '1',
      internalNotes: String(internalNotes || '').trim().slice(0, 1000),
      tenantNotes: String(tenantNotes || '').trim().slice(0, 1000),
      backupStatus: nextBackupStatus
    };
  }

  saveTenantsRegistry(tenants);
  console.log('[root-hosting] update', JSON.stringify({ tenantId, section: sec }));

  const rows = _buildHostingRows(loadTenantsRegistry());
  const unresolvedCount = rows.filter((row) => row.issueFlag || row.domainStatus !== 'active' || row.sslStatus !== 'active').length;
  const navCounts = getRootNavCounts();
  return res.render('root-hosting', { ...navCounts, rows, unresolvedCount, message: `[${sec}] ενημερώθηκε για ${tenantId}.`, error: null });
});

// ── HTTP smoke test helper ────────────────────────────────────────────────────
// GET <domain>/ and verify it's not Railway's own 404 page.
// Used to gate domain auto-promotion after DNS checks pass.
// Health check for VA assistant backend
async function checkAssistantHealth() {
  const vaUrl = (process.env.THRONOS_ASSISTANT_URL || process.env.ASSISTANT_API_URL || '').replace(/\/$/, '');
  if (!vaUrl) {
    return { ok: false, status: 'not_configured', message: 'VA backend URL not configured', responseTime: null };
  }

  try {
    const start = Date.now();
    const resp = await axios.get(`${vaUrl}/api/v1/health`, {
      timeout: 5000,
      validateStatus: (status) => status < 500
    });
    const responseTime = Date.now() - start;
    const ok = resp.status === 200;
    return {
      ok,
      status: ok ? 'healthy' : 'unhealthy',
      statusCode: resp.status,
      responseTime,
      message: ok ? 'Assistant backend is responsive' : `Assistant returned HTTP ${resp.status}`
    };
  } catch (err) {
    return {
      ok: false,
      status: 'unreachable',
      message: String(err.code || err.message),
      responseTime: null
    };
  }
}

async function httpSmoke(domain) {
  const RAILWAY_404_MARKER = 'The train has not arrived';
  for (const proto of ['https', 'http']) {
    try {
      const resp = await axios.get(`${proto}://${domain}/`, {
        headers: { 'User-Agent': 'ThronosVerify/1.0' },
        timeout: 8000,
        maxRedirects: 5,
        validateStatus: null
      });
      const body = typeof resp.data === 'string' ? resp.data : '';
      if (body.includes(RAILWAY_404_MARKER)) {
        return { ok: false, statusCode: resp.status, proto, note: 'Railway 404 — domain not configured in Railway dashboard' };
      }
      return { ok: resp.status < 500, statusCode: resp.status, proto };
    } catch (e) {
      if (proto === 'http') {
        return { ok: false, statusCode: 0, proto: 'none', note: String(e.code || e.message) };
      }
      // https failed — try http next
    }
  }
  return { ok: false, statusCode: 0, proto: 'none', note: 'unreachable' };
}

// ── DNS recheck endpoint ──────────────────────────────────────────────────────
function _buildHostingRows(tenants) {
  return tenants.map(t => ({
    tenantId: t.id,
    supportTier: t.supportTier,
    active: t.active !== false,
    ...getTenantHostingSnapshot(t, { tenant: t, tenantPaths: tenantPaths(t.id) })
  }));
}

app.post('/root/hosting/recheck', async (req, res) => {
  const { rootPassword, tenantId } = req.body;
  if (!verifyRootPassword(rootPassword)) {
    const rows = _buildHostingRows(loadTenantsRegistry());
    const navCounts = getRootNavCounts();
    return res.status(401).render('root-hosting', { ...navCounts, rows, unresolvedCount: rows.filter(r => r.issueFlag || r.domainStatus !== 'active').length, message: null, error: 'Λάθος root κωδικός.' });
  }
  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex(t => t.id === String(tenantId || '').trim());
  if (idx < 0) {
    const rows = _buildHostingRows(tenants);
    const navCounts = getRootNavCounts();
    return res.status(404).render('root-hosting', { ...navCounts, rows, unresolvedCount: 0, message: null, error: 'Tenant δεν βρέθηκε.' });
  }
  try {
    // Full check: public resolvers + Cloudflare API authoritative (if zone configured)
    const check = await runDomainCheckFull(tenants[idx]);
    const now = check.checkedAt;
    const prevHosting = tenants[idx].hosting || {};

    // ── HTTP smoke tests ─────────────────────────────────────────────────────
    // Use authoritative state (CF API) or public DNS to decide if domain is reachable.
    // If authoritative OK but public still propagating, smoke against domain still useful.
    const smokeResults = {};
    let allSmokeOk = false;
    const dnsLooksViable = check.cnameOk || check.flattenedApex ||
      (check.authoritativeOk === true); // auth ok even if public stale
    if (check.domain && dnsLooksViable) {
      const canonicalCfg = getTenantCanonicalConfig(tenants[idx]);
      const canonicalSmokeTarget = check.canonicalDomain || canonicalCfg.canonicalDomain || check.domain;
      const smokeTargets = [...new Set([canonicalSmokeTarget, check.domain, ...(check.aliases || []).map(a => a.domain)].filter(Boolean))];
      const smokeChecks = await Promise.allSettled(smokeTargets.map(d => httpSmoke(d)));
      smokeTargets.forEach((d, i) => {
        smokeResults[d] = smokeChecks[i].status === 'fulfilled'
          ? smokeChecks[i].value
          : { ok: false, note: smokeChecks[i].reason?.message };
      });
      allSmokeOk = Object.values(smokeResults).every(s => s.ok);
    }

    // ── DNS verification state ───────────────────────────────────────────────
    // Prefer authoritative (CF API) over public resolver for gate decisions.
    // If CF zone not configured, fall back to public.
    const authOk     = check.authoritativeOk;        // null if no CF zone
    const publicOk   = check.cnameOk && check.txtOk && check.allAliasesOk;
    const dnsVerifiedAuthoritative = authOk === true;
    const dnsVerifiedPublic        = publicOk;
    const dnsVerified              = dnsVerifiedAuthoritative || dnsVerifiedPublic;
    const propagating              = check.propagationStatus === 'propagating'; // auth ok, public not yet

    // ── Auto-promotion gate ──────────────────────────────────────────────────
    // Rules (in priority order):
    //   active            = dnsVerified + smoke ok + ssl active
    //   ssl_validating    = dnsVerified + smoke ok (or Railway verify ok)
    //   public_dns_propagating = authoritativeOk but public not yet resolved
    //   railway_pending   = dnsVerified + smoke not yet ok (Railway custom domain not bound)
    //   pending_dns       = no required records verified
    //   action_required   = CF says records wrong / conflicting
    let nextDomainStatus;
    if (dnsVerified && allSmokeOk) {
      nextDomainStatus = 'active';
    } else if (propagating) {
      nextDomainStatus = 'public_dns_propagating';
    } else if (dnsVerified && !allSmokeOk) {
      nextDomainStatus = 'railway_pending'; // DNS correct but HTTP not yet OK
    } else if (authOk === false) {
      nextDomainStatus = 'action_required'; // CF API says records are wrong
    } else {
      nextDomainStatus = 'pending_dns';
    }

    const detectedSslStatus = allSmokeOk ? 'active' : (dnsVerified ? 'pending' : 'pending');
    tenants[idx].hosting = {
      ...prevHosting,
      lastCheckedAt: now,
      lastCheckError: '',
      sslStatus: detectedSslStatus,
      dnsVerifiedAt: dnsVerified ? now : (prevHosting.dnsVerifiedAt || ''),
      domainStatus: nextDomainStatus,
      propagationStatus: check.propagationStatus || 'unknown',
      dnsCheckResult: JSON.stringify({
        cname:           check.cname,
        txt:             check.txt,
        aliases:         check.aliases,
        smoke:           smokeResults,
        requiredRecords: check.requiredRecords,
        detectedRecords: check.detectedRecords,
        authoritative:   check.authoritative,
        propagationStatus: check.propagationStatus,
        cfError:         check.cfError
      }),
      aliasResults: check.aliases || []
    };
    // Promote legacy domainStatus field when fully verified
    if (nextDomainStatus === 'active' || nextDomainStatus === 'ssl_validating') {
      tenants[idx].domainStatus = nextDomainStatus;
    }
    saveTenantsRegistry(tenants);

    const refreshed = loadTenantsRegistry();
    const rows = _buildHostingRows(refreshed);
    const unresolvedCount = rows.filter(r => r.issueFlag || r.domainStatus !== 'active' || r.sslStatus !== 'active').length;
    const apexNote  = check.flattenedApex ? ' (apex-A/CF)' : '';
    const authNote  = check.authoritativeOk !== null ? ` Auth=${check.authoritativeOk ? '✓' : '✗'}` : '';
    const propNote  = check.propagationStatus ? ` [${check.propagationStatus}]` : '';
    const aliasNote = check.aliases && check.aliases.length ? ` Aliases=${check.allAliasesOk ? '✓' : '✗'}` : '';
    const smokeNote = Object.keys(smokeResults).length ? ` Smoke=${allSmokeOk ? '✓' : '✗'}` : '';
    const summary   = `Recheck ${tenants[idx].id}: CNAME=${check.cnameOk ? '✓' : '✗'}${apexNote}${authNote}${propNote} TXT=${check.txtOk ? '✓' : '✗'}${aliasNote}${smokeNote} → ${nextDomainStatus}`;
    const navCounts = getRootNavCounts();
    return res.render('root-hosting', { ...navCounts, rows, unresolvedCount, message: summary, error: null });
  } catch (err) {
    console.error('[root/hosting/recheck] error:', err.message);
    const tenants2 = loadTenantsRegistry();
    const idx2 = tenants2.findIndex(t => t.id === String(tenantId || '').trim());
    if (idx2 >= 0) {
      tenants2[idx2].hosting = { ...(tenants2[idx2].hosting || {}), lastCheckError: err.message, lastCheckedAt: new Date().toISOString() };
      saveTenantsRegistry(tenants2);
    }
    const rows = _buildHostingRows(loadTenantsRegistry());
    const navCounts = getRootNavCounts();
    return res.render('root-hosting', { ...navCounts, rows, unresolvedCount: 0, message: null, error: `DNS check απέτυχε: ${err.message}` });
  }
});

// ── Cloudflare configuration (per-tenant zone ID; token from env or per-tenant override) ──
app.post('/root/hosting/cloudflare', (req, res) => {
  const { tenantId, cfApiToken, cfZoneId, clearTokenOverride } = req.body;
  if (!verifyRootPassword(req.body.rootPassword || '')) {
    setRootFlash(req, { error: 'Λάθος root κωδικός.' });
    return res.redirect('/root/hosting');
  }
  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex(t => t.id === String(tenantId || '').trim());
  if (idx < 0) {
    setRootFlash(req, { error: 'Tenant δεν βρέθηκε.' });
    return res.redirect('/root/hosting');
  }

  // Zone ID is per-tenant only. API token behavior:
  // - clearTokenOverride=true => delete per-tenant token so env fallback is used
  // - non-empty cfApiToken    => save per-tenant override
  // - empty cfApiToken        => keep existing token as-is
  tenants[idx] = applyTenantCloudflareConfig(tenants[idx], { cfZoneId, cfApiToken, clearTokenOverride });
  saveTenantsRegistry(tenants);

  const zoneStored = tenants[idx].hosting.cloudflareZoneId || '(not set)';
  const tokenSource = (tenants[idx].hosting.cloudflareApiToken || '').trim()
    ? 'per-tenant'
    : (process.env.CLOUDFLARE_API_TOKEN ? 'env' : 'none');
  const message = `Cloudflare config updated for ${tenantId}: zone=${zoneStored}, token=${tokenSource}`;
  setRootFlash(req, { message });
  return res.redirect('/root/hosting');
});

// ── Cloudflare DNS sync (idempotent) ─────────────────────────────────────────
app.post('/root/hosting/cf-sync', async (req, res) => {
  const { tenantId, railwayTargets: railwayTargetsJson, railwayVerifyTokens: railwayVerifyJson } = req.body;
  if (!verifyRootPassword(req.body.rootPassword || '')) {
    setRootFlash(req, { error: 'Λάθος root κωδικός.' });
    return res.redirect('/root/hosting');
  }
  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex(t => t.id === String(tenantId || '').trim());
  if (idx < 0) {
    setRootFlash(req, { error: 'Tenant δεν βρέθηκε.' });
    return res.redirect('/root/hosting');
  }

  const tenant = tenants[idx];
  const zoneId = getTenantZoneId(tenant);
  const cf = getCloudflareClient(tenant);

  if (!cf) {
    setRootFlash(req, { error: 'Cloudflare API token not configured (set CLOUDFLARE_API_TOKEN env or per-tenant token).' });
    return res.redirect('/root/hosting');
  }
  if (!zoneId) {
    setRootFlash(req, { error: 'Cloudflare Zone ID not configured for this tenant. Set it in the DNS tab.' });
    return res.redirect('/root/hosting');
  }

  let railwayTargets = {};
  let railwayVerifyTokens = {};
  try {
    if (railwayTargetsJson) railwayTargets = JSON.parse(railwayTargetsJson);
    if (railwayVerifyJson) railwayVerifyTokens = JSON.parse(railwayVerifyJson);
  } catch (e) {
    setRootFlash(req, { error: `Invalid JSON in Railway targets: ${e.message}` });
    return res.redirect('/root/hosting');
  }

  try {
    const results = await cf.syncTenantDnsRecords(zoneId, {
      primaryDomain: tenant.primaryDomain || tenant.domain,
      aliases: tenant.domains || [],
      tenantId: tenant.id,
      railwayTargets,
      railwayVerifyTokens
    });
    const summary = results.map(r => `${r.input.type} ${r.input.name}: ${r.action}`).join(', ');
    setRootFlash(req, { message: `Cloudflare DNS sync complete for ${tenantId}: ${summary}` });
  } catch (err) {
    console.error('[cf-sync] error:', err.message);
    setRootFlash(req, { error: `Cloudflare sync failed: ${err.message}` });
  }
  return res.redirect('/root/hosting');
});

// ── Railway deployment registration ──────────────────────────────────────────
app.post('/root/hosting/railway', (req, res) => {
  const { tenantId, railwayDeploymentId, railwayUrl } = req.body;
  if (!verifyRootPassword(req.body.rootPassword || '')) {
    setRootFlash(req, { error: 'Λάθος root κωδικός.' });
    return res.redirect('/root/hosting');
  }
  const tenants = loadTenantsRegistry();
  const idx = tenants.findIndex(t => t.id === String(tenantId || '').trim());
  if (idx < 0) {
    setRootFlash(req, { error: 'Tenant δεν βρέθηκε.' });
    return res.redirect('/root/hosting');
  }

  if (!railwayDeploymentId || !railwayUrl) {
    setRootFlash(req, { error: 'Deployment ID and URL are required.' });
    return res.redirect('/root/hosting');
  }

  // Register in railway registry using canonical domain when canonical www is enabled
  try {
    const canonicalCfg = getTenantCanonicalConfig(tenants[idx]);
    const registryDomain = canonicalCfg.canonicalDomain || tenants[idx].primaryDomain || tenants[idx].domain;
    if (registryDomain && railwayRegistry) {
      railwayRegistry.register(registryDomain, railwayDeploymentId, railwayUrl, 'active');
    }
    const message = `Railway deployment registered: ${railwayDeploymentId}`;
    setRootFlash(req, { message });
  } catch (err) {
    setRootFlash(req, { error: `Railway registration failed: ${err.message}` });
  }
  return res.redirect('/root/hosting');
});

// ── Assistant health check ───────────────────────────────────────────────────
app.post('/root/hosting/assistant-health', async (req, res) => {
  try {
    const health = await checkAssistantHealth();
    return res.json(health);
  } catch (err) {
    console.error('[assistant-health] error:', err.message);
    return res.status(500).json({ ok: false, status: 'error', message: err.message });
  }
});

// ── VA Chat proxy (storefront) ────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  if (!req.tenant || req.isPlatformRequest) {
    return res.status(404).json({ error: 'not found' });
  }
  const config = loadTenantConfig(req);
  const assistant = (config && config.assistant) || {};
  if (!assistant.vaEnabled || !['customer', 'both'].includes(assistant.vaMode)) {
    return res.status(403).json({ error: 'Chat assistant not available for this store.' });
  }
  const vaUrl = (process.env.THRONOS_ASSISTANT_URL || process.env.ASSISTANT_API_URL || '').replace(/\/$/, '');
  if (!vaUrl) {
    return res.status(503).json({ error: 'Assistant service not configured.' });
  }
  const { message, context } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  try {
    const commerceKey = (process.env.THRONOS_COMMERCE_API_KEY || '').trim();
    const tokenRes = await axios.post(
      `${vaUrl}/api/v1/auth/customer-token`,
      {
        commerce_tenant_id: req.tenantId,
        customer_id: (req.session && req.session.user && req.session.user.id)
          ? String(req.session.user.id) : null,
        customer_email: (req.session && req.session.user && req.session.user.email)
          ? String(req.session.user.email) : null,
      },
      {
        headers: commerceKey ? { 'X-Thronos-Commerce-Key': commerceKey } : {},
        timeout: 5000,
      }
    );
    const token = tokenRes.data && tokenRes.data.access_token;
    if (!token) throw new Error('No token received from VA');
    const chatRes = await axios.post(
      `${vaUrl}/api/v1/assistant/chat`,
      {
        message: String(message).trim().slice(0, 2000),
        role: 'customer',
        context: (context && typeof context === 'object') ? context : null,
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    return res.json(chatRes.data);
  } catch (err) {
    console.error('[VA chat] proxy error:', err.message);
    const httpStatus = (err.response && err.response.status) || 502;
    const detail = (err.response && err.response.data && err.response.data.detail)
      || 'Assistant temporarily unavailable.';
    return res.status(httpStatus >= 500 ? 502 : httpStatus).json({ error: detail });
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[express] unhandled error:', err && err.stack ? err.stack : String(err));
  if (res.headersSent) return;
  res.status(500).send(
    '<!doctype html><html><body style="font-family:system-ui;padding:20px;">' +
    '<h2>500 – Something went wrong</h2>' +
    '<p>An unexpected error occurred. Please try again or contact support.</p>' +
    '</body></html>'
  );
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

// ── Boot env audit (presence only — never log values) ────────────────────────
console.log('[boot] Thronos Commerce starting', {
  pid: process.pid,
  node: process.version,
  env: process.env.NODE_ENV || 'development',
});
console.log('[boot] Env audit:', {
  PORT: !!process.env.PORT,
  SESSION_SECRET: !!process.env.SESSION_SECRET,
  THRC_DATA_ROOT: !!process.env.THRC_DATA_ROOT,
  THRC_SMTP: !!(process.env.THRC_SMTP_HOST && process.env.THRC_SMTP_USER),
  EMAIL_ENABLED: process.env.EMAIL_ENABLED,
  STRIPE: !!(process.env.STRIPE_SECRET_KEY),
  STRIPE_WEBHOOK: !!(process.env.STRIPE_WEBHOOK_SECRET),
  THRC_ASSISTANT_API_KEY: !!process.env.THRC_ASSISTANT_API_KEY,
  THRONOS_COMMERCE_API_KEY: !!process.env.THRONOS_COMMERCE_API_KEY,
  COMMERCE_WEBHOOK_SECRET: !!process.env.COMMERCE_WEBHOOK_SECRET,
  THRONOS_ASSISTANT_URL: !!(process.env.THRONOS_ASSISTANT_URL || process.env.ASSISTANT_API_URL),
  THRONOS_ROOT_ADMIN: !!(process.env.THRONOS_ROOT_ADMIN_PASSWORD),
  THRONOS_NODE_URL: !!process.env.THRONOS_NODE_URL,
});
console.log('[boot] DATA_ROOT:', DATA_ROOT);

if (process.env.THRC_PREFLIGHT_EJS === '1') {
  try {
    console.log('[boot] EJS preflight starting...');
    const ok = preflightCompileTemplates();
    console.log('[boot] EJS preflight', ok ? 'OK' : 'completed with template errors (continuing)');
  } catch (e) {
    console.error('[boot] EJS preflight warning:', e.message);
  }
}

// Run migrations
try {
  migrateToProvisioningSchema();
  console.log('[boot] Tenant provisioning schema migration completed');
} catch (e) {
  console.error('[boot] Migration error:', e.message);
}

// Initialize Railway Registry
try {
  railwayRegistry = new RailwayRegistry(RAILWAY_REGISTRY_FILE);
  console.log('[boot] Railway registry loaded');
} catch (e) {
  console.error('[boot] Railway registry error:', e.message);
}

app.listen(PORT, () => {
  console.log(`[boot] Thronos Commerce listening on port ${PORT}`);
});
