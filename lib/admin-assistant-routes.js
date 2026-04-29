'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { buildTenantContext } = require('./admin-assistant-context');
const { readAuditLog, appendAuditEntry } = require('./admin-assistant-audit');

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
  'primaryColor', 'accentColor', 'fontFamily',
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

function _setNestedPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// Minimal native-http JSON fetch (avoids adding node-fetch dependency).
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

/**
 * Register tenant-admin assistant routes on `app`.
 * Call once from server.js after all helper functions are defined:
 *
 *   require('./lib/admin-assistant-routes')(app, {
 *     requireAdmin,
 *     loadTenantConfig,
 *     saveTenantConfig,
 *     verifyAdminAction,
 *     buildAdminViewModel,
 *   });
 */
module.exports = function setupAdminAssistantRoutes(app, {
  requireAdmin,
  loadTenantConfig,
  saveTenantConfig,
  verifyAdminAction,
  buildAdminViewModel,
}) {
  // ------------------------------------------------------------------ //
  // GET /admin/assistant-panel — render the assistant panel             //
  // ------------------------------------------------------------------ //
  app.get('/admin/assistant-panel', requireAdmin, (req, res) => {
    res.render('admin-assistant', buildAdminViewModel(req, {
      pageTitle: 'Βοηθός',
      activeSection: 'assistant-panel',
    }));
  });

  // ------------------------------------------------------------------ //
  // POST /admin/assistant-panel/chat — proxy to VCA                    //
  // ------------------------------------------------------------------ //
  app.post('/admin/assistant-panel/chat', requireAdmin, async (req, res) => {
    const { message, section, conversationHistory } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Missing message' });
    }

    const vcaUrl = process.env.VCA_URL || process.env.ASSISTANT_URL || '';
    if (!vcaUrl) {
      return res.status(503).json({ error: 'Assistant service not configured (VCA_URL missing)' });
    }

    const tenantContext = buildTenantContext(req);
    const history = Array.isArray(conversationHistory) ? conversationHistory.slice(-10) : [];

    try {
      const result = await _fetchJson(
        `${vcaUrl}/api/v1/admin/assistant/chat`,
        {
          method: 'POST',
          headers: { 'X-Thronos-Commerce-Key': process.env.COMMERCE_WEBHOOK_SECRET || '' },
          timeout: 30000,
        },
        {
          message: message.trim().slice(0, 2000),
          tenant_context: tenantContext,
          section: section || null,
          conversation_history: history,
        }
      );

      if (result.status !== 200) {
        return res.status(502).json({ error: 'Assistant error', detail: String(result.body).slice(0, 200) });
      }

      appendAuditEntry(req.tenantPaths, {
        tenantId: req.tenant.id,
        action: 'chat',
        message: message.trim().slice(0, 200),
        section: section || null,
        intent: (result.body && result.body.intent) || null,
        hasProposals: Array.isArray(result.body && result.body.proposed_patches)
          && result.body.proposed_patches.length > 0,
      });

      return res.json(result.body);
    } catch (err) {
      return res.status(503).json({ error: 'Assistant service unreachable' });
    }
  });

  // ------------------------------------------------------------------ //
  // POST /admin/assistant-panel/approve — apply approved patches        //
  // ------------------------------------------------------------------ //
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
        return res.status(401).json({ error: 'Λάθος κωδικός διαχειριστή (απαιτείται για ευαίσθητες αλλαγές)' });
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

  // ------------------------------------------------------------------ //
  // GET /admin/assistant-panel/audit-log — return audit entries (JSON)  //
  // ------------------------------------------------------------------ //
  app.get('/admin/assistant-panel/audit-log', requireAdmin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const entries = readAuditLog(req.tenantPaths, limit);
    return res.json({ entries });
  });
};
