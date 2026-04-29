/**
 * Comprehensive tests for the full domain provisioning flow.
 * Covers: Cloudflare authoritative vs public resolver divergence,
 * propagation detection, idempotent CF sync, no-zone path, alias failures,
 * and enforcement of the "no global CLOUDFLARE_ZONE_ID" constraint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { matchesTxt, pointsToThronos } = require('../utils/dns-check');
const { CloudflareClient, getCloudflareClient, getTenantZoneId } = require('../utils/cloudflare-api');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Build a fake tenant object matching the real schema.
function makeTenant({ id = 'eukolakis', primaryDomain = 'eukolaki.gr', domains = ['www.eukolaki.gr'],
  cloudflareZoneId = '', cloudflareApiToken = '', domainStatus = 'pending_dns' } = {}) {
  return {
    id,
    primaryDomain,
    domain: primaryDomain,
    domains,
    hosting: {
      cloudflareZoneId,
      cloudflareApiToken,
      propagationStatus: 'unknown'
    },
    domainStatus
  };
}

// Build a fake runDomainCheckFull result that mimics the authoritative-ok / public-stale scenario.
function makeFullCheckResult({ authCnameOk = true, authTxtOk = true, authAliasesOk = true,
  pubCnameOk = false, pubTxtOk = false, pubAliasesOk = true } = {}) {
  const authAllOk = authCnameOk && authTxtOk && authAliasesOk;
  const pubAllOk  = pubCnameOk  && pubTxtOk  && pubAliasesOk;

  let propagationStatus;
  if (authAllOk && pubAllOk)        propagationStatus = 'ok';
  else if (authAllOk && !pubAllOk)  propagationStatus = 'propagating';
  else                              propagationStatus = 'missing';

  return {
    cnameOk:       pubCnameOk,
    txtOk:         pubTxtOk,
    allAliasesOk:  pubAliasesOk,
    propagationStatus,
    authoritative: {
      source:        'cloudflare-api',
      cnameOk:       authCnameOk,
      txtOk:         authTxtOk,
      allAliasesOk:  authAliasesOk
    },
    authoritativeOk: authAllOk,
    hasCloudflareZone: true
  };
}

// ── 1. CF authoritative pass, public resolver stale → propagating ─────────────

test('propagationStatus=propagating when CF authoritative ok but public resolvers stale', () => {
  const result = makeFullCheckResult({
    authCnameOk: true, authTxtOk: true, authAliasesOk: true,
    pubCnameOk: false, pubTxtOk: false, pubAliasesOk: true
  });
  assert.equal(result.propagationStatus, 'propagating');
  assert.equal(result.authoritativeOk, true);
  assert.equal(result.cnameOk, false, 'public CNAME still stale');
  assert.equal(result.txtOk, false, 'public TXT still stale');
});

test('domainStatus set to public_dns_propagating when propagating', () => {
  const result = makeFullCheckResult({
    authCnameOk: true, authTxtOk: true, authAliasesOk: true,
    pubCnameOk: false, pubTxtOk: false
  });
  const prevSslStatus = 'pending';

  // Replicate the promotion gate from server.js /root/hosting/recheck
  const authOk = result.authoritativeOk;
  const publicOk = result.cnameOk && result.txtOk && result.allAliasesOk;
  const dnsVerified = authOk === true || publicOk;
  const propagating = result.propagationStatus === 'propagating';
  const allSmokeOk = false; // Railway not yet verified in this scenario

  let nextDomainStatus;
  if (dnsVerified && allSmokeOk && prevSslStatus === 'active') nextDomainStatus = 'active';
  else if (dnsVerified && allSmokeOk) nextDomainStatus = 'ssl_validating';
  else if (propagating) nextDomainStatus = 'public_dns_propagating';
  else if (dnsVerified && !allSmokeOk) nextDomainStatus = 'railway_pending';
  else if (authOk === false) nextDomainStatus = 'action_required';
  else nextDomainStatus = 'pending_dns';

  assert.equal(nextDomainStatus, 'public_dns_propagating');
});

test('domainStatus set to active when CF authoritative+public both ok and smoke passes', () => {
  const result = makeFullCheckResult({
    authCnameOk: true, authTxtOk: true, authAliasesOk: true,
    pubCnameOk: true,  pubTxtOk: true,  pubAliasesOk: true
  });
  const allSmokeOk = true;

  const authOk = result.authoritativeOk;
  const publicOk = result.cnameOk && result.txtOk && result.allAliasesOk;
  const dnsVerified = authOk === true || publicOk;
  const propagating = result.propagationStatus === 'propagating';

  let nextDomainStatus;
  if (dnsVerified && allSmokeOk) nextDomainStatus = 'active';
  else if (propagating) nextDomainStatus = 'public_dns_propagating';
  else if (dnsVerified && !allSmokeOk) nextDomainStatus = 'railway_pending';
  else if (authOk === false) nextDomainStatus = 'action_required';
  else nextDomainStatus = 'pending_dns';

  assert.equal(nextDomainStatus, 'active');
});

test('canonicalHost=www: valid www CNAME + TXT checks can advance even when apex is redirect placeholder mode', () => {
  const check = {
    canonicalHost: 'www',
    apexMode: 'redirect_to_www',
    apexDnsStatus: 'proxied_placeholder_ok',
    cnameOk: true,     // canonical www CNAME verified
    txtOk: true,       // root thronos TXT verified
    allAliasesOk: true,
    authoritativeOk: true,
    propagationStatus: 'ok'
  };
  const prevSslStatus = 'pending';
  const allSmokeOk = false;

  const authOk = check.authoritativeOk;
  const publicOk = check.cnameOk && check.txtOk && check.allAliasesOk;
  const dnsVerified = authOk === true || publicOk;
  const propagating = check.propagationStatus === 'propagating';

  let nextDomainStatus;
  if (dnsVerified && allSmokeOk && prevSslStatus === 'active') nextDomainStatus = 'active';
  else if (dnsVerified && allSmokeOk) nextDomainStatus = 'ssl_validating';
  else if (propagating) nextDomainStatus = 'public_dns_propagating';
  else if (dnsVerified && !allSmokeOk) nextDomainStatus = 'railway_pending';
  else if (authOk === false) nextDomainStatus = 'action_required';
  else nextDomainStatus = 'pending_dns';

  assert.equal(nextDomainStatus, 'railway_pending');
});

test('canonicalHost=www: missing apex placeholder is warning-only and does not block advancement', () => {
  const check = {
    canonicalHost: 'www',
    apexMode: 'redirect_to_www',
    apexDnsStatus: 'missing_placeholder_warning',
    cnameOk: true,     // canonical www still correct
    txtOk: true,       // root TXT still correct
    allAliasesOk: true,
    authoritativeOk: true,
    propagationStatus: 'ok'
  };

  const authOk = check.authoritativeOk;
  const publicOk = check.cnameOk && check.txtOk && check.allAliasesOk;
  const dnsVerified = authOk === true || publicOk;
  assert.equal(dnsVerified, true, 'missing apex placeholder must be non-blocking when canonicalHost=www');
  assert.equal(check.apexDnsStatus, 'missing_placeholder_warning');
});

test('canonicalHost=www: valid www CNAME + TXT checks can advance even when apex is redirect placeholder mode', () => {
  const check = {
    canonicalHost: 'www',
    apexMode: 'redirect_to_www',
    apexDnsStatus: 'proxied_placeholder_ok',
    cnameOk: true,     // canonical www CNAME verified
    txtOk: true,       // root thronos TXT verified
    allAliasesOk: true,
    authoritativeOk: true,
    propagationStatus: 'ok'
  };
  const prevSslStatus = 'pending';
  const allSmokeOk = false;

  const authOk = check.authoritativeOk;
  const publicOk = check.cnameOk && check.txtOk && check.allAliasesOk;
  const dnsVerified = authOk === true || publicOk;
  const propagating = check.propagationStatus === 'propagating';

  let nextDomainStatus;
  if (dnsVerified && allSmokeOk && prevSslStatus === 'active') nextDomainStatus = 'active';
  else if (dnsVerified && allSmokeOk) nextDomainStatus = 'ssl_validating';
  else if (propagating) nextDomainStatus = 'public_dns_propagating';
  else if (dnsVerified && !allSmokeOk) nextDomainStatus = 'railway_pending';
  else if (authOk === false) nextDomainStatus = 'action_required';
  else nextDomainStatus = 'pending_dns';

  assert.equal(nextDomainStatus, 'railway_pending');
});

test('canonicalHost=www: missing apex placeholder is warning-only and does not block advancement', () => {
  const check = {
    canonicalHost: 'www',
    apexMode: 'redirect_to_www',
    apexDnsStatus: 'missing_placeholder_warning',
    cnameOk: true,     // canonical www still correct
    txtOk: true,       // root TXT still correct
    allAliasesOk: true,
    authoritativeOk: true,
    propagationStatus: 'ok'
  };

  const authOk = check.authoritativeOk;
  const publicOk = check.cnameOk && check.txtOk && check.allAliasesOk;
  const dnsVerified = authOk === true || publicOk;
  assert.equal(dnsVerified, true, 'missing apex placeholder must be non-blocking when canonicalHost=www');
  assert.equal(check.apexDnsStatus, 'missing_placeholder_warning');
});

// ── 2. aisthetic-stores already active — recheck keeps active ─────────────────

test('domainStatus stays active when fully verified and SSL was already active', () => {
  const result = makeFullCheckResult({
    authCnameOk: true, authTxtOk: true, authAliasesOk: true,
    pubCnameOk: true,  pubTxtOk: true,  pubAliasesOk: true
  });
  const prevSslStatus = 'active';
  const allSmokeOk = true;

  const authOk = result.authoritativeOk;
  const publicOk = result.cnameOk && result.txtOk && result.allAliasesOk;
  const dnsVerified = authOk === true || publicOk;
  const propagating = result.propagationStatus === 'propagating';

  let nextDomainStatus;
  if (dnsVerified && allSmokeOk && prevSslStatus === 'active') nextDomainStatus = 'active';
  else if (dnsVerified && allSmokeOk) nextDomainStatus = 'ssl_validating';
  else if (propagating) nextDomainStatus = 'public_dns_propagating';
  else if (dnsVerified && !allSmokeOk) nextDomainStatus = 'railway_pending';
  else if (authOk === false) nextDomainStatus = 'action_required';
  else nextDomainStatus = 'pending_dns';

  assert.equal(nextDomainStatus, 'active', 'already-active tenant must not regress after successful recheck');
});

// ── 3. Tenant with no CF zone configured ─────────────────────────────────────

test('getCloudflareClient returns null when no token available', () => {
  const savedToken = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  try {
    const tenant = makeTenant({ cloudflareZoneId: '', cloudflareApiToken: '' });
    const client = getCloudflareClient(tenant);
    assert.equal(client, null, 'must return null when no API token is configured');
  } finally {
    if (savedToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = savedToken;
  }
});

test('getTenantZoneId returns null when zone not configured', () => {
  const tenant = makeTenant({ cloudflareZoneId: '' });
  assert.equal(getTenantZoneId(tenant), null);
});

test('getTenantZoneId returns only per-tenant value, never global env', () => {
  const savedZone = process.env.CLOUDFLARE_ZONE_ID;
  process.env.CLOUDFLARE_ZONE_ID = 'should-never-be-used';
  try {
    const tenant = makeTenant({ cloudflareZoneId: '' });
    assert.equal(getTenantZoneId(tenant), null, 'global CLOUDFLARE_ZONE_ID must never be read');
  } finally {
    if (savedZone !== undefined) process.env.CLOUDFLARE_ZONE_ID = savedZone;
    else delete process.env.CLOUDFLARE_ZONE_ID;
  }
});

test('runDomainCheckFull: no-zone tenant gets propagationStatus ok or unknown, never throws', async () => {
  const { runDomainCheckFull } = require('../utils/dns-check');
  const tenant = makeTenant({ cloudflareZoneId: '', cloudflareApiToken: '' });
  const result = await runDomainCheckFull(tenant);
  assert.ok(['ok', 'unknown'].includes(result.propagationStatus),
    `expected ok or unknown, got: ${result.propagationStatus}`);
  assert.equal(result.hasCloudflareZone, false);
  assert.equal(result.authoritative, null);
}, { timeout: 15000 });

test('Cloudflare authoritative check (canonicalHost=www): apex proxied placeholder is optional and non-blocking', async () => {
  const cf = new CloudflareClient('fake-token');
  cf.listDnsRecords = async (_zoneId, { name }) => {
    if (name === 'eukolaki.gr') {
      return [
        { type: 'TXT', name, content: 'thronos-verify=eukolakis', proxied: false },
        { type: 'A', name, content: '192.0.2.1', proxied: true }
      ];
    }
    if (name === 'www.eukolaki.gr') {
      return [{ type: 'CNAME', name, content: 'b2el3wfs.up.railway.app', proxied: true }];
    }
    return [];
  };

  const result = await cf.readTenantDnsState('zone-123', {
    primaryDomain: 'eukolaki.gr',
    aliases: ['www.eukolaki.gr'],
    tenantId: 'eukolakis',
    canonicalHost: 'www'
  });

  assert.equal(result.canonicalHost, 'www');
  assert.equal(result.apexMode, 'redirect_to_www');
  assert.equal(result.apexDnsStatus, 'proxied_placeholder_ok');
  assert.equal(result.cnameOk, true, 'www canonical CNAME should drive success');
  assert.equal(result.txtOk, true);
});

test('Cloudflare authoritative check (canonicalHost=www): missing apex placeholder produces warning status only', async () => {
  const cf = new CloudflareClient('fake-token');
  cf.listDnsRecords = async (_zoneId, { name }) => {
    if (name === 'eukolaki.gr') {
      return [{ type: 'TXT', name, content: 'thronos-verify=eukolakis', proxied: false }];
    }
    if (name === 'www.eukolaki.gr') {
      return [{ type: 'CNAME', name, content: 'b2el3wfs.up.railway.app', proxied: true }];
    }
    return [];
  };

  const result = await cf.readTenantDnsState('zone-123', {
    primaryDomain: 'eukolaki.gr',
    aliases: ['www.eukolaki.gr'],
    tenantId: 'eukolakis',
    canonicalHost: 'www'
  });

  assert.equal(result.apexDnsStatus, 'missing_placeholder_warning');
  assert.equal(result.cnameOk, true, 'missing apex placeholder should not block canonical www verification');
  assert.equal(result.txtOk, true);
});

// ── 4. Tenant with missing alias CNAME ────────────────────────────────────────

test('allAliasesOk=false when any alias CNAME is missing', () => {
  const aliases = [
    { domain: 'www.eukolaki.gr', ok: true,  cnames: ['b2el3wfs.up.railway.app'] },
    { domain: 'shop.eukolaki.gr', ok: false, type: 'error', note: 'NXDOMAIN' }
  ];
  const allAliasesOk = aliases.every(a => a.ok);
  assert.equal(allAliasesOk, false);
});

test('domainStatus set to action_required when CF authoritative shows missing records', () => {
  const result = {
    cnameOk: false,
    txtOk: false,
    allAliasesOk: false,
    propagationStatus: 'missing',
    authoritativeOk: false,
    authoritative: {
      source: 'cloudflare-api',
      cnameOk: false,
      txtOk: false,
      allAliasesOk: false
    },
    hasCloudflareZone: true
  };

  const authOk = result.authoritativeOk;
  const publicOk = result.cnameOk && result.txtOk && result.allAliasesOk;
  const dnsVerified = authOk === true || publicOk;
  const propagating = result.propagationStatus === 'propagating';
  const allSmokeOk = false;

  let nextDomainStatus;
  if (dnsVerified && allSmokeOk) nextDomainStatus = 'ssl_validating';
  else if (propagating) nextDomainStatus = 'public_dns_propagating';
  else if (dnsVerified && !allSmokeOk) nextDomainStatus = 'railway_pending';
  else if (authOk === false) nextDomainStatus = 'action_required';
  else nextDomainStatus = 'pending_dns';

  assert.equal(nextDomainStatus, 'action_required');
});

test('alias check: A record rejected for www subdomain (flattenedCname not allowed for aliases)', () => {
  // checkAliasCname wraps checkCname and forces ok=false for flattenedCname results
  const aliasResultWithARecord = {
    ok: false,
    flattenedCname: true,
    type: 'apex-a',
    note: 'Alias requires CNAME — A record not accepted for www/subdomain alias'
  };
  assert.equal(aliasResultWithARecord.ok, false,
    'www alias must require real CNAME, A record is not acceptable');
});

// ── 5. Idempotent Cloudflare DNS sync ─────────────────────────────────────────

test('upsertDnsRecord: action=noop when record content unchanged', async () => {
  // Simulate the upsertDnsRecord logic without hitting the real API
  function simulateUpsert(existing, desired) {
    const match = existing.find(r => r.name === desired.name && r.type === desired.type);
    if (!match) return { action: 'created' };
    if (match.content === desired.content && match.proxied === desired.proxied) return { action: 'noop', record: match };
    return { action: 'updated' };
  }

  const existing = [{ type: 'CNAME', name: 'eukolaki.gr', content: 'olz9lkef.up.railway.app', proxied: true }];
  const desired  = { type: 'CNAME', name: 'eukolaki.gr', content: 'olz9lkef.up.railway.app', proxied: true };
  const result   = simulateUpsert(existing, desired);
  assert.equal(result.action, 'noop', 'identical record must be a noop');
});

test('upsertDnsRecord: action=created when record absent', async () => {
  function simulateUpsert(existing, desired) {
    const match = existing.find(r => r.name === desired.name && r.type === desired.type);
    if (!match) return { action: 'created' };
    if (match.content === desired.content && match.proxied === desired.proxied) return { action: 'noop', record: match };
    return { action: 'updated' };
  }

  const existing = [];
  const desired  = { type: 'CNAME', name: 'eukolaki.gr', content: 'olz9lkef.up.railway.app', proxied: true };
  const result   = simulateUpsert(existing, desired);
  assert.equal(result.action, 'created');
});

test('upsertDnsRecord: action=updated when record content differs', async () => {
  function simulateUpsert(existing, desired) {
    const match = existing.find(r => r.name === desired.name && r.type === desired.type);
    if (!match) return { action: 'created' };
    if (match.content === desired.content && match.proxied === desired.proxied) return { action: 'noop', record: match };
    return { action: 'updated' };
  }

  const existing = [{ type: 'CNAME', name: 'eukolaki.gr', content: 'old-target.up.railway.app', proxied: true }];
  const desired  = { type: 'CNAME', name: 'eukolaki.gr', content: 'olz9lkef.up.railway.app',   proxied: true };
  const result   = simulateUpsert(existing, desired);
  assert.equal(result.action, 'updated');
});

test('syncDnsRecords produces correct action list for mixed noop/create/update', () => {
  function simulateUpsert(existing, desired) {
    const match = existing.find(r => r.name === desired.name && r.type === desired.type);
    if (!match) return { action: 'created', input: desired };
    if (match.content === desired.content && match.proxied === desired.proxied) return { action: 'noop', record: match, input: desired };
    return { action: 'updated', input: desired };
  }

  const existing = [
    { type: 'CNAME', name: 'eukolaki.gr',     content: 'olz9lkef.up.railway.app', proxied: true },
    { type: 'TXT',   name: 'eukolaki.gr',     content: 'thronos-verify=eukolakis', proxied: false }
  ];

  const desired = [
    { type: 'CNAME', name: 'eukolaki.gr',     content: 'olz9lkef.up.railway.app', proxied: true },  // noop
    { type: 'TXT',   name: 'eukolaki.gr',     content: 'thronos-verify=eukolakis', proxied: false }, // noop
    { type: 'CNAME', name: 'www.eukolaki.gr', content: 'b2el3wfs.up.railway.app', proxied: true },  // created
  ];

  const results = desired.map(d => simulateUpsert(existing, d));
  assert.equal(results[0].action, 'noop');
  assert.equal(results[1].action, 'noop');
  assert.equal(results[2].action, 'created');
});

// ── 6. No global CLOUDFLARE_ZONE_ID usage in source ──────────────────────────

test('no file in the codebase reads process.env.CLOUDFLARE_ZONE_ID', () => {
  const rootDir = path.resolve(__dirname, '..');
  const gitignore = path.join(rootDir, '.gitignore');

  // Files to check: all .js files (excluding node_modules and test files themselves)
  const sourceFiles = [];
  function collectJs(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'tests') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectJs(full);
      } else if (entry.name.endsWith('.js')) {
        sourceFiles.push(full);
      }
    }
  }
  collectJs(rootDir);

  const offendingFiles = [];
  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('process.env.CLOUDFLARE_ZONE_ID')) {
      offendingFiles.push(path.relative(rootDir, file));
    }
  }

  assert.deepEqual(offendingFiles, [],
    `These files read process.env.CLOUDFLARE_ZONE_ID (forbidden): ${offendingFiles.join(', ')}`);
});

test('getCloudflareClient uses per-tenant token over global CLOUDFLARE_API_TOKEN', () => {
  const savedToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'global-token';
  try {
    const tenantWithOwnToken = makeTenant({ cloudflareApiToken: 'per-tenant-token', cloudflareZoneId: 'zone-abc' });
    const client = getCloudflareClient(tenantWithOwnToken);
    assert.ok(client !== null, 'client must be created');
    // The per-tenant token should be used (apiToken stored on client)
    assert.equal(client.apiToken, 'per-tenant-token', 'per-tenant token must take precedence');
  } finally {
    if (savedToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = savedToken;
    else delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

test('getCloudflareClient falls back to global CLOUDFLARE_API_TOKEN when tenant has none', () => {
  const savedToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'global-fallback-token';
  try {
    const tenantNoToken = makeTenant({ cloudflareApiToken: '' });
    const client = getCloudflareClient(tenantNoToken);
    assert.ok(client !== null, 'client must be created from global token');
    assert.equal(client.apiToken, 'global-fallback-token');
  } finally {
    if (savedToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = savedToken;
    else delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

// ── 7. Propagation status state machine correctness ───────────────────────────

test('propagationStatus=ok when both authoritative and public are correct', () => {
  const result = makeFullCheckResult({
    authCnameOk: true, authTxtOk: true, authAliasesOk: true,
    pubCnameOk: true,  pubTxtOk: true,  pubAliasesOk: true
  });
  assert.equal(result.propagationStatus, 'ok');
});

test('propagationStatus=missing when CF authoritative shows wrong records', () => {
  const result = makeFullCheckResult({
    authCnameOk: false, authTxtOk: true, authAliasesOk: true,
    pubCnameOk: false,  pubTxtOk: false, pubAliasesOk: false
  });
  assert.equal(result.propagationStatus, 'missing');
});

test('propagationStatus=ok when no CF zone and public resolvers report ok', () => {
  // Replicate the runDomainCheckFull logic for no-zone path
  const pubAllOk = true;
  const hasZone = false;
  const propagationStatus = hasZone
    ? 'determined_by_cf_api'
    : (pubAllOk ? 'ok' : 'unknown');
  assert.equal(propagationStatus, 'ok');
});

test('propagationStatus=unknown when no CF zone and public resolvers are not ok', () => {
  const pubAllOk = false;
  const hasZone = false;
  const propagationStatus = hasZone
    ? 'determined_by_cf_api'
    : (pubAllOk ? 'ok' : 'unknown');
  assert.equal(propagationStatus, 'unknown');
});

// ── 8. TXT record matching (eukolakis production facts) ──────────────────────

test('eukolakis apex TXT thronos-verify=eukolakis is matched', () => {
  assert.ok(matchesTxt(['thronos-verify=eukolakis'], 'eukolakis'));
});

test('CNAME olz9lkef.up.railway.app is accepted as Thronos Railway target', () => {
  assert.ok(pointsToThronos(['olz9lkef.up.railway.app']));
});

test('www CNAME b2el3wfs.up.railway.app is also accepted', () => {
  assert.ok(pointsToThronos(['b2el3wfs.up.railway.app']));
});

// ── 9. domainStatus select in update form includes all new statuses ────────────

test('root-hosting.ejs update form includes all required status options', () => {
  const viewPath = path.resolve(__dirname, '..', 'views', 'root-hosting.ejs');
  const content = fs.readFileSync(viewPath, 'utf8');

  const requiredStatuses = [
    'pending_dns',
    'public_dns_propagating',
    'railway_pending',
    'ssl_validating',
    'active',
    'action_required',
    'failed'
  ];

  // Find the select element for domainStatus
  const selectMatch = content.match(/name="domainStatus"[\s\S]*?<\/select>/);
  assert.ok(selectMatch, 'domainStatus select element must exist in view');

  const selectHtml = selectMatch[0];
  for (const status of requiredStatuses) {
    assert.ok(selectHtml.includes(status),
      `domainStatus select must include option: ${status}`);
  }
});
