const https = require('https');
const http = require('http');
const { URL } = require('url');
const { buildTenantContext } = require('./admin-assistant-context');
const { readAuditLog, appendAuditEntry } = require('./admin-assistant-audit');
const { resolveVcaUrl, resolveWebhookSecret, logAssistantBoot } = require('./admin-assistant-env');

// Proxy timeout: override via VCA_PROXY_TIMEOUT_MS env var (useful in tests).
const VCA_PROXY_TIMEOUT_MS = () =>
  Math.max(5000, parseInt(process.env.VCA_PROXY_TIMEOUT_MS || '30000', 10));

// Config field paths safe to apply without admin password re-entry.
const SAFE_FIELDS = new Set([
  'theme.presetId', 'theme.menuBg', 'theme.menuText', 'theme.menuActiveBg',
  'theme.menuActiveText', 'theme.buttonRadius', 'theme.headerLayout',
  'theme.authPosition', 'theme.menuStyle', 'theme.heroStyle',
  'theme.categoryMenuStyle', 'theme.cardStyle', 'theme.sectionSpacing',
  'theme.bannerVisible', 'theme.logoDisplayMode', 'theme.logoBgMode',
  'theme.logoPadding', 'theme.logoRadius', 'theme.logoShadow',
  'theme.logoMaxHeight', 'theme.productThumbAspect', 'theme.productThumbFit',
  'theme.productThumbBg', 'theme.productCardHoverEffect', 'theme.cardDensity',
  'theme.footerTextColor', 'theme.homeLayoutPreset',
  'theme.headerMenuStyle', 'theme.colorMode',
  'theme.storefrontBgUrl', 'theme.headerHeroLogoOpacity',
  'primaryColor', 'accentColor', 'fontFamily',
  'storeName', 'heroTitle', 'heroText', 'heroSubtitle',
  'assistant.vaEnabled', 'assistant.vaMode', 'assistant.vaLanguage',
  'assistant.vaTone', 'assistant.vaBrandVoice', 'assistant.vaStoreInstructions',
  'assistant.vaProductGuidance', 'assistant.vaCustomerSupport',
  'assistant.vaAvoidTopics', 'assistant.vaMerchantGoals',
  'footer.contactEmail', 'footer.facebookUrl', 'footer.instagramUrl',
  'footer.tiktokUrl',
]);

// Fields that require admin password re-entry before applying.
const SENSITIVE_FIELDS = new Set([
  'notifications.notificationEmail',
  'notifications.replyToEmail',
  'notifications.enabled',
]);

const ALL_ALLOWED = new Set([...SAFE_FIELDS, ...SENSITIVE_FIELDS]);

// Action types the VA can propose (beyond config patches).
const ALLOWED_ACTIONS = new Set([
  'add_product', 'update_product', 'delete_product',
  'add_category', 'update_category', 'delete_category',
  'add_shipping_option', 'update_shipping_option', 'delete_shipping_option',
]);

function _setNestedPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function _makeSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'item';
}

function _makeId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// Minimal native-http JSON fetch — avoids adding node-fetch as a dependency.
function _fetchJson(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : '';
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...(options.headers || {}),
      },
      timeout: options.timeout || 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('VCA request timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function _classifyError(err) {
  if (!err) return 'unknown';
  if (err.message === 'VCA request timeout') return 'timeout';
  if (err.code === 'ECONNREFUSED') return 'econnrefused';
  if (err.code === 'ENOTFOUND') return 'enotfound';
  if (err.code === 'ECONNABORTED') return 'timeout';
  if (err.code) return `net_${err.code}`;
  return 'network_error';
}

function setupAdminAssistantRoutes(app, {
  requireAdmin,
  loadTenantConfig,
  saveTenantConfig,
  loadTenantProducts,
  saveTenantProducts,
  loadTenantCategories,
  saveTenantCategories,
  verifyAdminAction,
  buildAdminViewModel,
}) {
  logAssistantBoot('admin-assistant');

  app.get('/admin/assistant-panel', requireAdmin, (req, res) => {
    res.render('admin-assistant', buildAdminViewModel(req, {
      pageTitle: 'Βοηθός',
      activeSection: 'assistant-panel',
    }));
  });

  app.post('/admin/assistant-panel/chat', requireAdmin, async (req, res) => {
    const { message, section, conversationHistory } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Missing message' });
    }

    const { url: vcaUrl, source: vcaSource } = resolveVcaUrl();
    if (!vcaUrl) {
      return res.status(503).json({
        error: 'Assistant service not configured. Set THRONOS_ASSISTANT_URL.',
      });
    }

    const { secret: webhookSecret } = resolveWebhookSecret();
    const tenantContext = buildTenantContext(req);
    const history = Array.isArray(conversationHistory) ? conversationHistory.slice(-10) : [];
    const timeout = VCA_PROXY_TIMEOUT_MS();

    try {
      const result = await _fetchJson(
        `${vcaUrl}/api/v1/admin/assistant/chat`,
        { method: 'POST', headers: { 'X-Thronos-Commerce-Key': webhookSecret }, timeout },
        {
          message: message.trim().slice(0, 2000),
          tenant_context: tenantContext,
          section: section || null,
          conversation_history: history,
        }
      );

      if (result.status !== 200) {
        console.error(
          '[admin-assistant] chat upstream error tenant=%s path=POST /api/v1/admin/assistant/chat' +
          ' reason=http_%d urlSource=%s',
          req.tenant.id, result.status, vcaSource
        );
        return res.status(502).json({
          error: 'Assistant error',
          detail: String(result.body).slice(0, 200),
        });
      }

      const hasProposals = (
        (Array.isArray(result.body && result.body.proposed_patches) && result.body.proposed_patches.length > 0) ||
        (Array.isArray(result.body && result.body.proposed_actions) && result.body.proposed_actions.length > 0)
      );

      appendAuditEntry(req.tenantPaths, {
        tenantId: req.tenant.id,
        action: 'chat',
        message: message.trim().slice(0, 200),
        section: section || null,
        intent: (result.body && result.body.intent) || null,
        hasProposals,
      });

      return res.json(result.body);
    } catch (err) {
      const reason = _classifyError(err);
      console.error(
        '[admin-assistant] chat proxy error tenant=%s path=POST /api/v1/admin/assistant/chat' +
        ' reason=%s urlSource=%s',
        req.tenant.id, reason, vcaSource
      );
      if (reason === 'timeout') {
        return res.status(504).json({ error: 'Assistant service timed out' });
      }
      return res.status(503).json({ error: 'Assistant service unreachable' });
    }
  });

  // ── Config patch approval (existing flow) ──────────────────────────
  app.post('/admin/assistant-panel/approve', requireAdmin, async (req, res) => {
    const { patches, password } = req.body;

    if (!Array.isArray(patches) || patches.length === 0) {
      return res.status(400).json({ error: 'No patches provided' });
    }
    if (patches.length > 20) {
      return res.status(400).json({ error: 'Too many patches in a single request (max 20)' });
    }

    const forbidden = patches.filter(p => !ALL_ALLOWED.has(p.field_path));
    if (forbidden.length > 0) {
      return res.status(403).json({
        error: 'Some fields cannot be modified via the assistant',
        fields: forbidden.map(p => p.field_path),
      });
    }

    const sensitive = patches.filter(p => SENSITIVE_FIELDS.has(p.field_path));
    if (sensitive.length > 0) {
      const auth = await verifyAdminAction(req, password);
      if (!auth.ok) {
        return res.status(401).json({
          error: 'Λάθος κωδικός διαχειριστή (απαιτείται για ευαίσθητες αλλαγές)',
        });
      }
    }

    const config = loadTenantConfig(req);
    const applied = [];
    for (const patch of patches) {
      if (ALL_ALLOWED.has(patch.field_path)) {
        _setNestedPath(config, patch.field_path, patch.proposed_value);
        applied.push(patch.field_path);
      }
    }
    saveTenantConfig(req, config);

    appendAuditEntry(req.tenantPaths, {
      tenantId: req.tenant.id,
      action: 'approve',
      patches: patches.map(p => ({ field_path: p.field_path, proposed_value: p.proposed_value })),
      applied,
    });

    return res.json({ ok: true, applied });
  });

  // ── Action approval (new: product/category/shipping mutations) ─────
  app.post('/admin/assistant-panel/approve-action', requireAdmin, async (req, res) => {
    const { actions } = req.body;

    if (!Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'No actions provided' });
    }
    if (actions.length > 10) {
      return res.status(400).json({ error: 'Too many actions (max 10)' });
    }

    const forbidden = actions.filter(a => !ALLOWED_ACTIONS.has(a.action));
    if (forbidden.length > 0) {
      return res.status(403).json({
        error: 'Unknown action types',
        actions: forbidden.map(a => a.action),
      });
    }

    const results = [];

    for (const act of actions) {
      try {
        const outcome = _executeAction(req, act, {
          loadTenantConfig, saveTenantConfig,
          loadTenantProducts, saveTenantProducts,
          loadTenantCategories, saveTenantCategories,
        });
        results.push({ action: act.action, ok: true, ...outcome });
      } catch (err) {
        results.push({ action: act.action, ok: false, error: err.message });
      }
    }

    appendAuditEntry(req.tenantPaths, {
      tenantId: req.tenant.id,
      action: 'approve_actions',
      actions: actions.map(a => ({ action: a.action, params: a.params })),
      results: results.map(r => ({ action: r.action, ok: r.ok })),
    });

    return res.json({ ok: true, results });
  });

  app.get('/admin/assistant-panel/audit-log', requireAdmin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const entries = readAuditLog(req.tenantPaths, limit);
    return res.json({ entries });
  });
}

function _executeAction(req, act, helpers) {
  const p = act.params || {};

  switch (act.action) {
    case 'add_product': {
      const products = helpers.loadTenantProducts(req);
      const newProduct = {
        id: _makeId('prod'),
        name: String(p.name || '').trim().slice(0, 200),
        price: Math.max(0, Number(p.price) || 0),
        description: String(p.description || '').trim().slice(0, 5000),
        category: String(p.category || '').trim(),
        imageUrl: String(p.imageUrl || '').trim().slice(0, 500),
        stock: p.stock != null ? Math.max(0, parseInt(p.stock, 10) || 0) : null,
        visible: true,
        type: 'SIMPLE',
      };
      if (!newProduct.name) throw new Error('Product name is required');
      products.push(newProduct);
      helpers.saveTenantProducts(req, products);
      return { product_id: newProduct.id, name: newProduct.name };
    }

    case 'update_product': {
      const products = helpers.loadTenantProducts(req);
      const idx = products.findIndex(pr => pr.id === p.product_id);
      if (idx === -1) throw new Error('Product not found: ' + p.product_id);
      const updates = p.updates || {};
      if (updates.name != null) products[idx].name = String(updates.name).trim().slice(0, 200);
      if (updates.price != null) products[idx].price = Math.max(0, Number(updates.price) || 0);
      if (updates.description != null) products[idx].description = String(updates.description).trim().slice(0, 5000);
      if (updates.category != null) products[idx].category = String(updates.category).trim();
      if (updates.imageUrl != null) products[idx].imageUrl = String(updates.imageUrl).trim().slice(0, 500);
      if (updates.stock != null) products[idx].stock = Math.max(0, parseInt(updates.stock, 10) || 0);
      if (updates.visible != null) products[idx].visible = !!updates.visible;
      helpers.saveTenantProducts(req, products);
      return { product_id: p.product_id };
    }

    case 'delete_product': {
      const products = helpers.loadTenantProducts(req);
      const before = products.length;
      const filtered = products.filter(pr => pr.id !== p.product_id);
      if (filtered.length === before) throw new Error('Product not found: ' + p.product_id);
      helpers.saveTenantProducts(req, filtered);
      return { product_id: p.product_id, deleted: true };
    }

    case 'add_category': {
      const categories = helpers.loadTenantCategories(req);
      const newCat = {
        id: _makeSlug(p.name) || _makeId('cat'),
        name: String(p.name || '').trim().slice(0, 100),
        slug: _makeSlug(p.slug || p.name),
        description: String(p.description || '').trim().slice(0, 500),
        showInMainNav: true,
        image: String(p.image || '').trim().slice(0, 500),
      };
      if (!newCat.name) throw new Error('Category name is required');
      let suffix = 2;
      const usedIds = new Set(categories.map(c => c.id));
      while (usedIds.has(newCat.id)) { newCat.id = `${_makeSlug(p.name)}-${suffix++}`; }
      categories.push(newCat);
      helpers.saveTenantCategories(req, categories);
      return { category_id: newCat.id, name: newCat.name };
    }

    case 'update_category': {
      const categories = helpers.loadTenantCategories(req);
      const idx = categories.findIndex(c => c.id === p.category_id);
      if (idx === -1) throw new Error('Category not found: ' + p.category_id);
      const updates = p.updates || {};
      if (updates.name != null) categories[idx].name = String(updates.name).trim().slice(0, 100);
      if (updates.slug != null) categories[idx].slug = _makeSlug(updates.slug);
      if (updates.description != null) categories[idx].description = String(updates.description).trim().slice(0, 500);
      if (updates.image != null) categories[idx].image = String(updates.image).trim().slice(0, 500);
      if (updates.showInMainNav != null) categories[idx].showInMainNav = !!updates.showInMainNav;
      helpers.saveTenantCategories(req, categories);
      return { category_id: p.category_id };
    }

    case 'delete_category': {
      const categories = helpers.loadTenantCategories(req);
      const before = categories.length;
      const filtered = categories.filter(c => c.id !== p.category_id);
      if (filtered.length === before) throw new Error('Category not found: ' + p.category_id);
      helpers.saveTenantCategories(req, filtered);
      return { category_id: p.category_id, deleted: true };
    }

    case 'add_shipping_option': {
      const config = helpers.loadTenantConfig(req);
      if (!Array.isArray(config.shippingOptions)) config.shippingOptions = [];
      const newShip = {
        id: _makeSlug(p.label) || _makeId('ship'),
        label: String(p.label || '').trim().slice(0, 100),
        type: String(p.type || 'courier').trim(),
        base: Math.max(0, Number(p.base) || 0),
        codFee: Math.max(0, Number(p.codFee) || 0),
      };
      if (!newShip.label) throw new Error('Shipping label is required');
      let suffix = 2;
      const usedIds = new Set(config.shippingOptions.map(s => s.id));
      while (usedIds.has(newShip.id)) { newShip.id = `${_makeSlug(p.label)}-${suffix++}`; }
      config.shippingOptions.push(newShip);
      helpers.saveTenantConfig(req, config);
      return { shipping_id: newShip.id, label: newShip.label };
    }

    case 'update_shipping_option': {
      const config = helpers.loadTenantConfig(req);
      if (!Array.isArray(config.shippingOptions)) throw new Error('No shipping options configured');
      const idx = config.shippingOptions.findIndex(s => s.id === p.shipping_id);
      if (idx === -1) throw new Error('Shipping option not found: ' + p.shipping_id);
      const updates = p.updates || {};
      if (updates.label != null) config.shippingOptions[idx].label = String(updates.label).trim().slice(0, 100);
      if (updates.type != null) config.shippingOptions[idx].type = String(updates.type).trim();
      if (updates.base != null) config.shippingOptions[idx].base = Math.max(0, Number(updates.base) || 0);
      if (updates.codFee != null) config.shippingOptions[idx].codFee = Math.max(0, Number(updates.codFee) || 0);
      helpers.saveTenantConfig(req, config);
      return { shipping_id: p.shipping_id };
    }

    case 'delete_shipping_option': {
      const config = helpers.loadTenantConfig(req);
      if (!Array.isArray(config.shippingOptions)) throw new Error('No shipping options configured');
      const before = config.shippingOptions.length;
      config.shippingOptions = config.shippingOptions.filter(s => s.id !== p.shipping_id);
      if (config.shippingOptions.length === before) throw new Error('Shipping option not found: ' + p.shipping_id);
      helpers.saveTenantConfig(req, config);
      return { shipping_id: p.shipping_id, deleted: true };
    }

    default:
      throw new Error('Unknown action: ' + act.action);
  }
}

module.exports = { setupAdminAssistantRoutes };
