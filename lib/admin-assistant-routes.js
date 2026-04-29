function setupAdminAssistantRoutes(deps) {
  const {
    app,
    requireAdmin,
    buildAdminViewModel,
    loadTenantConfig,
    withTenantLink,
    axios,
    resolveAssistantEnv
  } = deps;

  app.get('/admin/assistant-panel', requireAdmin, (req, res) => {
    return res.render('admin', buildAdminViewModel(req, { openAssistantPanel: true }));
  });

  app.post('/admin/assistant-panel/chat', requireAdmin, async (req, res) => {
    const { assistantUrl: vaUrl } = resolveAssistantEnv();
    if (!vaUrl) return res.status(503).json({ error: 'Assistant backend URL is not configured.' });
    try {
      const payload = {
        tenant_id: req.tenant && req.tenant.id,
        message: String((req.body && req.body.message) || '').trim(),
        context: req.body && req.body.context ? req.body.context : {}
      };
      const r = await axios.post(`${vaUrl}/api/v1/admin/assistant/chat`, payload, { timeout: 10000 });
      return res.json(r.data || {});
    } catch (err) {
      const status = (err.response && err.response.status) || 502;
      return res.status(status >= 500 ? 502 : status).json({ error: 'Assistant request failed.' });
    }
  });
}

module.exports = { setupAdminAssistantRoutes };
