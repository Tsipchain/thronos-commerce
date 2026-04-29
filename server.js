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