'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 500;

function _logPath(tenantPaths) {
  return path.join(tenantPaths.data, 'admin-assistant-audit.json');
}

/**
 * Read the most recent audit entries for this tenant (newest first).
 */
function readAuditLog(tenantPaths, limit) {
  const n = Math.min(limit || 50, 200);
  try {
    const entries = JSON.parse(fs.readFileSync(_logPath(tenantPaths), 'utf8'));
    return Array.isArray(entries) ? entries.slice(-n).reverse() : [];
  } catch {
    return [];
  }
}

/**
 * Append one entry to the tenant audit log, enforcing MAX_ENTRIES cap.
 */
function appendAuditEntry(tenantPaths, entry) {
  const logPath = _logPath(tenantPaths);
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { entries = []; }
  if (!Array.isArray(entries)) entries = [];
  entries.push({ ...entry, timestamp: new Date().toISOString() });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(entries, null, 2), 'utf8');
}

module.exports = { readAuditLog, appendAuditEntry };
