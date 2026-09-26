'use strict';

const fs = require('fs');

function _loadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function _productSummary(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    id: p.id || '',
    name: p.name || '',
    price: p.price != null ? Number(p.price) : null,
    category: p.category || '',
    stock: p.stock != null ? Number(p.stock) : null,
    type: p.type || 'SIMPLE',
    imageUrl: p.imageUrl || '',
    visible: p.visible !== false,
  };
}

function _categorySummary(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    id: c.id || '',
    name: c.name || '',
    slug: c.slug || '',
    description: c.description || '',
    showInMainNav: c.showInMainNav !== false,
    image: c.image || '',
  };
}

function _orderSummary(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    id: o.id || '',
    status: o.status || 'pending',
    customer: o.customer || o.customerName || '',
    email: o.email || '',
    total: o.total != null ? Number(o.total) : null,
    date: o.createdAt || o.date || '',
    shippingMethod: o.shippingMethodLabel || o.shippingMethodId || '',
    paymentMethod: o.paymentMethodLabel || o.paymentMethodId || '',
    itemCount: Array.isArray(o.items) ? o.items.length : 0,
  };
}

/**
 * Build a sanitised tenant context snapshot to send to the VCA admin assistant.
 * Never includes credentials, adminPasswordHash, payment secrets, or other tenants' data.
 * Includes product/category/order/shipping data for AI tool-use.
 */
function buildTenantContext(req) {
  const config = _loadJson(req.tenantPaths.config) || {};
  const products = _loadJson(req.tenantPaths.products) || [];
  const categories = _loadJson(req.tenantPaths.categories) || [];
  let orders = [];
  try { orders = _loadJson(req.tenantPaths.orders) || []; } catch (_) {}

  const productList = Array.isArray(products)
    ? products.map(_productSummary).filter(Boolean).slice(0, 200)
    : [];
  const categoryList = Array.isArray(categories)
    ? categories.map(_categorySummary).filter(Boolean)
    : [];
  const recentOrders = Array.isArray(orders)
    ? orders.slice(-50).reverse().map(_orderSummary).filter(Boolean)
    : [];

  const shippingOptions = Array.isArray(config.shippingOptions)
    ? config.shippingOptions.map(s => ({
        id: s.id || '', label: s.label || '', type: s.type || 'courier',
        base: Number(s.base || 0), codFee: Number(s.codFee || 0),
      }))
    : [];

  const paymentOptions = Array.isArray(config.paymentOptions)
    ? config.paymentOptions.map(p => ({
        id: p.id || '', label: p.label || '', type: p.type || '',
      }))
    : [];

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
    // Full data for AI tool-use
    products: productList,
    categories: categoryList,
    recent_orders: recentOrders,
    shipping_options: shippingOptions,
    payment_options: paymentOptions,
    // Legacy counts (backward compat)
    categories_count: categoryList.length,
    products_count: productList.length,
    allowed_theme_keys: req.tenant.allowedThemeKeys || [],
    support_tier: req.tenant.supportTier || 'SELF_SERVICE',
  };
}

module.exports = { buildTenantContext };
