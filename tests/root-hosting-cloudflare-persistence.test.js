const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverPath = path.resolve(__dirname, '..', 'server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');

function extractFunctionSource(name) {
  const marker = `function ${name}(`;
  const start = serverSource.indexOf(marker);
  if (start < 0) throw new Error(`Function not found: ${name}`);

  const braceStart = serverSource.indexOf('{', start);
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
    normalizeThemeKeys: (keys) => keys
  });

  const tenants = loadTenantsRegistry();
  assert.equal(tenants[0].hosting.cloudflareZoneId, 'zone-eukolaki-gr');
  assert.equal(tenants[0].hosting.cloudflareApiToken, 'tenant-token');
});

test('getTenantHostingSnapshot reports hasCloudflareZone=true when tenant hosting zone exists', () => {
  const getTenantHostingSnapshot = instantiateFunction('getTenantHostingSnapshot', {
    loadTenantConfig: () => ({}),
    railwayRegistry: { getForTenant: () => ({}) }
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
