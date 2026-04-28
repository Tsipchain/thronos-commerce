const path = require('path');
const fs = require('fs');

// Railway registry stores per-domain deployment metadata:
// {
//   "eukolaki.gr": {
//     "deploymentId": "dep_abc123",
//     "url": "https://eukolaki-gr-prod.up.railway.app",
//     "status": "active",
//     "createdAt": "2026-04-28T...",
//     "lastDeployAt": "2026-04-28T..."
//   },
//   "www.eukolaki.gr": {
//     "deploymentId": "dep_def456",
//     "url": "https://www-eukolaki-gr-prod.up.railway.app",
//     "status": "active",
//     ...
//   }
// }

class RailwayRegistry {
  constructor(registryPath) {
    this.path = registryPath;
    this.data = this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.path)) {
        return {};
      }
      const raw = fs.readFileSync(this.path, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.warn(`[railway-registry] Failed to load: ${e.message}`);
      return {};
    }
  }

  _save() {
    const tmp = this.path + '.tmp.' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.path);
    } catch (e) {
      console.error(`[railway-registry] Failed to save: ${e.message}`);
      throw e;
    }
  }

  // Register a domain's Railway deployment
  register(domain, deploymentId, url, status = 'active') {
    if (!domain || !deploymentId || !url) {
      throw new Error('domain, deploymentId, and url are required');
    }
    const now = new Date().toISOString();
    this.data[domain] = {
      deploymentId,
      url,
      status,
      createdAt: (this.data[domain] && this.data[domain].createdAt) || now,
      lastDeployAt: now
    };
    this._save();
    return this.data[domain];
  }

  // Get deployment info for a domain
  get(domain) {
    return this.data[domain] || null;
  }

  // Update deployment status
  updateStatus(domain, status) {
    if (!this.data[domain]) {
      throw new Error(`Domain ${domain} not registered`);
    }
    this.data[domain].status = status;
    this.data[domain].lastUpdatedAt = new Date().toISOString();
    this._save();
    return this.data[domain];
  }

  // Update URL (in case of redeployment)
  updateUrl(domain, newUrl) {
    if (!this.data[domain]) {
      throw new Error(`Domain ${domain} not registered`);
    }
    this.data[domain].url = newUrl;
    this.data[domain].lastDeployAt = new Date().toISOString();
    this._save();
    return this.data[domain];
  }

  // Update deployment ID (after Railway redeploy)
  updateDeploymentId(domain, newId) {
    if (!this.data[domain]) {
      throw new Error(`Domain ${domain} not registered`);
    }
    this.data[domain].deploymentId = newId;
    this.data[domain].lastDeployAt = new Date().toISOString();
    this._save();
    return this.data[domain];
  }

  // Unregister a domain
  unregister(domain) {
    if (this.data[domain]) {
      delete this.data[domain];
      this._save();
    }
  }

  // Get all registered domains
  getAll() {
    return { ...this.data };
  }

  // Get registrations for a tenant (all its domains and aliases)
  getForTenant(primaryDomain, aliases = []) {
    const domains = [primaryDomain, ...aliases].filter(Boolean);
    const result = {};
    for (const domain of domains) {
      const entry = this.get(domain);
      if (entry) {
        result[domain] = entry;
      }
    }
    return result;
  }

  // Check if a domain is registered
  isRegistered(domain) {
    return !!this.data[domain];
  }

  // Get domains by status
  getByStatus(status) {
    const result = {};
    for (const [domain, entry] of Object.entries(this.data)) {
      if (entry.status === status) {
        result[domain] = entry;
      }
    }
    return result;
  }
}

module.exports = RailwayRegistry;
