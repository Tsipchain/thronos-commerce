const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getCloudflareClient } = require('../utils/cloudflare-api');

const serverPath = path.resolve(__dirname, '..', 'server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');

function extractFunctionSource(name) {
  const marker = `function ${name}(`;
  const start = serverSource.indexOf(marker);
  if (start < 0) throw new Error(`Function not found: ${name}`);

  const paramsStart = serverSource.indexOf('(', start);
  let parenDepth = 0;
  let braceStart = -1;
  for (let i = paramsStart; i < serverSource.length; i += 1) {
    const ch = serverSource[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        braceStart = serverSource.indexOf('{', i);
        break;
      }
    }
  }
  if (braceStart < 0) throw new Error(`Could not locate body start for: ${name}`);
  let depth = 0;
  for (let i = braceStart; i < serverSource.length; i += 1) {
    const ch = serverSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return serverSource.slice(start, i + 1);
    }
  }
  throw new Error(`Could not parse function source: ${name}`);
}

function instantiateFunction(name, contextValues) {
  const fnSource = extractFunctionSource(name);
  const context = vm.createContext({ ...contextValues, process });
  const script = new vm.Script(`${fnSource}; ${name};`);
  return script.runInContext(context);
}

test('save zone persistence: loadTenantsRegistry preserves hosting.cloudflareZoneId in returned tenant', () => {
  const getTenantPoweredByConfig = instantiateFunction('getTenantPoweredByConfig', {});
  const loadTenantsRegistry = instantiateFunction('loadTenantsRegistry', {
    TENANTS_REGISTRY: '/tmp/tenants.json',
    loadJson: () => ([{
      id: 'eukolakis',
      allowedThemeKeys: ['classic'],
      hosting: {
        cloudflareZoneId: 'zone-eukolaki-gr',
        cloudflareApiToken: 'tenant-token',
        domainStatus: 'pending_dns'
      }
    }]),
    loadThemeGovernance: () => ({ availableThemeKeys: ['classic'] }),
    normalizeThemeKeys: (keys) => keys,
    getTenantPoweredByConfig
  });

  const tenants = loadTenantsRegistry();
  assert.equal(tenants[0].hosting.cloudflareZoneId, 'zone-eukolaki-gr');
  assert.equal(tenants[0].hosting.cloudflareApiToken, 'tenant-token');
});

test('getTenantHostingSnapshot reports hasCloudflareZone=true when tenant hosting zone exists', () => {
  const getTenantCanonicalConfig = instantiateFunction('getTenantCanonicalConfig', {});
  const getTenantPoweredByConfig = instantiateFunction('getTenantPoweredByConfig', {});
  const getTenantHostingSnapshot = instantiateFunction('getTenantHostingSnapshot', {
    loadTenantConfig: () => ({}),
    railwayRegistry: { getForTenant: () => ({}) },
    getTenantCanonicalConfig,
    getTenantPoweredByConfig
  });

  const snapshot = getTenantHostingSnapshot({
    id: 'eukolakis',
    domain: 'eukolaki.gr',
    primaryDomain: 'eukolaki.gr',
    domains: ['www.eukolaki.gr'],
    hosting: { cloudflareZoneId: 'zone-eukolaki-gr' }
  }, null);

  assert.equal(snapshot.cloudflareZoneId, 'zone-eukolaki-gr');
  assert.equal(snapshot.hasCloudflareZone, true);
});

test('DNS recheck flow depends on tenant-hosting zone path and never reads process.env.CLOUDFLARE_ZONE_ID', () => {
  const recheckRouteIdx = serverSource.indexOf("app.post('/root/hosting/recheck'");
  assert.ok(recheckRouteIdx >= 0, 'recheck route block should exist');

  const recheckSnippet = serverSource.slice(recheckRouteIdx, recheckRouteIdx + 2200);
  assert.match(recheckSnippet, /runDomainCheckFull\(tenants\[idx\]\)/,
    'recheck should call runDomainCheckFull with the selected tenant');
  assert.doesNotMatch(recheckSnippet, /process\.env\.CLOUDFLARE_ZONE_ID/,
    'recheck route must never read global CLOUDFLARE_ZONE_ID');

  const dnsCheckSource = fs.readFileSync(path.resolve(__dirname, '..', 'utils', 'dns-check.js'), 'utf8');
  assert.match(dnsCheckSource, /hosting\.cloudflareZoneId/,
    'runDomainCheckFull should read tenant.hosting.cloudflareZoneId');
  assert.doesNotMatch(dnsCheckSource, /process\.env\.CLOUDFLARE_ZONE_ID/,
    'runDomainCheckFull must never use global CLOUDFLARE_ZONE_ID');
});

test('tenant with old cloudflareApiToken continues to use per-tenant token', () => {
  const savedToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'env-global-token';
  try {
    const tenant = { hosting: { cloudflareApiToken: 'tenant-override-token' } };
    const client = getCloudflareClient(tenant);
    assert.ok(client, 'expected Cloudflare client instance');
    assert.equal(client.apiToken, 'tenant-override-token');
  } finally {
    if (savedToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = savedToken;
    else delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

test('clearing override removes cloudflareApiToken and falls back to env token', () => {
  const applyTenantCloudflareConfig = instantiateFunction('applyTenantCloudflareConfig', {});
  const savedToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'env-global-token';
  try {
    const tenant = {
      id: 'eukolakis',
      hosting: {
        cloudflareZoneId: 'zone-eukolaki-gr',
        cloudflareApiToken: 'old-tenant-token'
      }
    };
    const updatedTenant = applyTenantCloudflareConfig(tenant, {
      cfZoneId: 'zone-eukolaki-gr',
      cfApiToken: '',
      clearTokenOverride: '1'
    });
    assert.equal(updatedTenant.hosting.cloudflareApiToken, undefined);

    const client = getCloudflareClient(updatedTenant);
    assert.ok(client, 'expected env fallback client');
    assert.equal(client.apiToken, 'env-global-token');
  } finally {
    if (savedToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = savedToken;
    else delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

test('empty token field preserves existing override unless clearTokenOverride is set', () => {
  const applyTenantCloudflareConfig = instantiateFunction('applyTenantCloudflareConfig', {});
  const tenant = {
    id: 'eukolakis',
    hosting: {
      cloudflareZoneId: 'zone-eukolaki-gr',
      cloudflareApiToken: 'existing-tenant-token'
    }
  };

  const unchanged = applyTenantCloudflareConfig(tenant, {
    cfZoneId: 'zone-eukolaki-gr',
    cfApiToken: '',
    clearTokenOverride: ''
  });
  assert.equal(unchanged.hosting.cloudflareApiToken, 'existing-tenant-token');
});

test('after override is cleared, hosting snapshot reports token source env', () => {
  const applyTenantCloudflareConfig = instantiateFunction('applyTenantCloudflareConfig', {});
  const getTenantCanonicalConfig = instantiateFunction('getTenantCanonicalConfig', {});
  const getTenantPoweredByConfig = instantiateFunction('getTenantPoweredByConfig', {});
  const getTenantHostingSnapshot = instantiateFunction('getTenantHostingSnapshot', {
    loadTenantConfig: () => ({}),
    railwayRegistry: { getForTenant: () => ({}) },
    getTenantCanonicalConfig,
    getTenantPoweredByConfig
  });
  const savedToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'env-global-token';
  try {
    const tenant = {
      id: 'eukolakis',
      primaryDomain: 'eukolaki.gr',
      domains: ['www.eukolaki.gr'],
      hosting: {
        cloudflareZoneId: 'zone-eukolaki-gr',
        cloudflareApiToken: 'old-tenant-token'
      }
    };
    const updatedTenant = applyTenantCloudflareConfig(tenant, {
      cfZoneId: 'zone-eukolaki-gr',
      cfApiToken: '',
      clearTokenOverride: '1'
    });

    const snapshot = getTenantHostingSnapshot(updatedTenant, null);
    assert.equal(snapshot.cloudflareTokenSource, 'env');
  } finally {
    if (savedToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = savedToken;
    else delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

test('canonical single source: canonicalToWww=true derives canonicalHost/apexMode consistently', () => {
  const getTenantCanonicalConfig = instantiateFunction('getTenantCanonicalConfig', {});
  const cfg = getTenantCanonicalConfig({
    domain: 'eukolaki.gr',
    primaryDomain: 'eukolaki.gr',
    canonicalToWww: true
  });
  assert.equal(cfg.canonicalHost, 'www');
  assert.equal(cfg.canonicalDomain, 'www.eukolaki.gr');
  assert.equal(cfg.apexMode, 'redirect_to_www');
  assert.equal(cfg.source, 'tenant.canonicalToWww');
});

test('/root/tenants/update and /root/hosting/recheck use tenant.canonicalToWww as persisted source', () => {
  const updateRouteIdx = serverSource.indexOf("app.post('/root/tenants/update'");
  assert.ok(updateRouteIdx >= 0, 'tenants update route should exist');
  const updateSnippet = serverSource.slice(updateRouteIdx, updateRouteIdx + 2200);
  assert.match(updateSnippet, /tenants\[idx\]\.canonicalToWww/);
  assert.doesNotMatch(updateSnippet, /canonicalHost\s*=/);
  assert.doesNotMatch(updateSnippet, /apexMode\s*=/);

  const recheckRouteIdx = serverSource.indexOf("app.post('/root/hosting/recheck'");
  assert.ok(recheckRouteIdx >= 0, 'hosting recheck route should exist');
  const recheckSnippet = serverSource.slice(recheckRouteIdx, recheckRouteIdx + 2400);
  assert.match(recheckSnippet, /runDomainCheckFull\(tenants\[idx\]\)/);
  assert.doesNotMatch(recheckSnippet, /tenants\[idx\]\.canonicalHost/);
  assert.doesNotMatch(recheckSnippet, /tenants\[idx\]\.apexMode/);
});

test('poweredByMode is normalized as active source; legacy allowPoweredBy does not override mode', () => {
  const getTenantPoweredByConfig = instantiateFunction('getTenantPoweredByConfig', {});
  const legacy = getTenantPoweredByConfig({ allowPoweredBy: true });
  assert.equal(legacy.poweredByMode, 'always');
  assert.equal(legacy.allowPoweredBy, true);

  const explicitDisabled = getTenantPoweredByConfig({ allowPoweredBy: true, poweredByMode: 'disabled' });
  assert.equal(explicitDisabled.poweredByMode, 'disabled');
  assert.equal(explicitDisabled.allowPoweredBy, false);
});

test('SSL manual save stores sslManualOverride and does not silently overwrite detected hosting.sslStatus', () => {
  const routeIdx = serverSource.indexOf("if (sec === 'ssl')");
  assert.ok(routeIdx >= 0, 'ssl section in /root/hosting/update should exist');
  const snippet = serverSource.slice(routeIdx, routeIdx + 700);
  assert.match(snippet, /sslManualOverride/);
  assert.doesNotMatch(snippet, /\.\.\.\(tenants\[idx\]\.hosting \|\| \{\}\),\s*sslStatus:/);
});
