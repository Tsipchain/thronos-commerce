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
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const crypto = require('crypto');
const axios = require('axios');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { normalizeHost, resolveTenantFromHost, tenantHostnames } = require('./utils/tenant-host-resolver');