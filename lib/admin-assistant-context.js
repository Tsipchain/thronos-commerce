'use strict';

const fs = require('fs');

function _loadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

/**
 * Build a sanitised tenant context snapshot to send to the VCA admin assistant.
 * Never includes credentials, adminPasswordHash, payment secrets, or other tenants' data.
 */
function buildTenantContext(req) {
  const config = _loadJson(req.tenantPaths.config) || {};
  const products = _loadJson(req.tenantPaths.products) || [];
  const categories = _loadJson(req.tenantPaths.categories) || [];

  return {
    tenant_id: req.tenant.id,
    store_name: config.storeName || '',
    theme: config.theme || {},
    branding: {
      primaryColor: config.primaryColor || '',
      accentColor: config.accentColor || '',
      fontFamily: config.fontFamily || '',
      logoPath: config.logoPath || '',
    },
    homepage: {
      heroTitle: config.heroTitle || '',
      heroText: config.heroText || '',
      heroSubtitle: config.heroSubtitle || '',
    },
    notifications: {
      enabled: !!(config.notifications && config.notifications.enabled),
      notificationEmail: config.notifications ? (config.notifications.notificationEmail || '') : '',
      replyToEmail: config.notifications ? (config.notifications.replyToEmail || '') : '',
    },
    assistant: {
      vaEnabled: !!(config.assistant && config.assistant.vaEnabled),
      vaMode: (config.assistant && config.assistant.vaMode) || 'disabled',
      vaLanguage: (config.assistant && config.assistant.vaLanguage) || 'auto',
      vaTone: (config.assistant && config.assistant.vaTone) || 'friendly',
      vaBrandVoice: (config.assistant && config.assistant.vaBrandVoice) || '',
      vaStoreInstructions: (config.assistant && config.assistant.vaStoreInstructions) || '',
      vaProductGuidance: (config.assistant && config.assistant.vaProductGuidance) || '',
      vaCustomerSupport: (config.assistant && config.assistant.vaCustomerSupport) || '',
      vaAvoidTopics: (config.assistant && config.assistant.vaAvoidTopics) || '',
      vaMerchantGoals: (config.assistant && config.assistant.vaMerchantGoals) || '',
    },
    payments_summary: {
      methods_configured: Object.keys(config.payments || {})
        .filter(k => config.payments[k] && config.payments[k].enabled),
    },
    footer: {
      contactEmail: (config.footer && config.footer.contactEmail) || '',
      facebookUrl: (config.footer && config.footer.facebookUrl) || '',
      instagramUrl: (config.footer && config.footer.instagramUrl) || '',
      tiktokUrl: (config.footer && config.footer.tiktokUrl) || '',
    },
    categories_count: Array.isArray(categories) ? categories.length : 0,
    products_count: Array.isArray(products) ? products.length : 0,
    allowed_theme_keys: req.tenant.allowedThemeKeys || [],
    support_tier: req.tenant.supportTier || 'SELF_SERVICE',
  };
}

module.exports = { buildTenantContext };
