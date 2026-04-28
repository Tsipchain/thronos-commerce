const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RailwayRegistry = require('../utils/railway-registry');

// Test counter
let testCount = 0;
let passedCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passedCount++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
  }
}

// ── Railway Registry Tests ───────────────────────────────────────────────────
const tmpFile = path.join(__dirname, '..', 'tmp-railway-test.json');

// Cleanup helper
function cleanup() {
  try { fs.unlinkSync(tmpFile); } catch (e) { }
}

test('Railway Registry: should initialize empty registry', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  assert.deepStrictEqual(reg.getAll(), {});
});

test('Railway Registry: should register a domain', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  const entry = reg.register('eukolaki.gr', 'dep_abc123', 'https://eukolaki-gr.up.railway.app');
  assert.strictEqual(entry.domain, undefined); // struct doesn't include domain key
  assert.strictEqual(entry.deploymentId, 'dep_abc123');
  assert.strictEqual(entry.url, 'https://eukolaki-gr.up.railway.app');
  assert.strictEqual(entry.status, 'active');
});

test('Railway Registry: should retrieve registered domain', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  reg.register('eukolaki.gr', 'dep_abc123', 'https://eukolaki-gr.up.railway.app');
  const entry = reg.get('eukolaki.gr');
  assert.strictEqual(entry.deploymentId, 'dep_abc123');
  assert.strictEqual(entry.status, 'active');
});

test('Railway Registry: should return null for unregistered domain', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  assert.strictEqual(reg.get('nonexistent.gr'), null);
});

test('Railway Registry: should update deployment status', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  reg.register('eukolaki.gr', 'dep_abc123', 'https://eukolaki-gr.up.railway.app');
  const updated = reg.updateStatus('eukolaki.gr', 'pending');
  assert.strictEqual(updated.status, 'pending');
});

test('Railway Registry: should update deployment URL', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  reg.register('eukolaki.gr', 'dep_abc123', 'https://eukolaki-gr.up.railway.app');
  const updated = reg.updateUrl('eukolaki.gr', 'https://eukolaki-gr-v2.up.railway.app');
  assert.strictEqual(updated.url, 'https://eukolaki-gr-v2.up.railway.app');
});

test('Railway Registry: should unregister a domain', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  reg.register('eukolaki.gr', 'dep_abc123', 'https://eukolaki-gr.up.railway.app');
  reg.unregister('eukolaki.gr');
  assert.strictEqual(reg.get('eukolaki.gr'), null);
});

test('Railway Registry: should get all registered domains', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  reg.register('eukolaki.gr', 'dep_abc123', 'https://eukolaki-gr.up.railway.app');
  reg.register('www.eukolaki.gr', 'dep_def456', 'https://www-eukolaki-gr.up.railway.app');
  const all = reg.getAll();
  assert.strictEqual(Object.keys(all).length, 2);
  assert.strictEqual(all['eukolaki.gr'].deploymentId, 'dep_abc123');
});

test('Railway Registry: should check if domain is registered', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  reg.register('eukolaki.gr', 'dep_abc123', 'https://eukolaki-gr.up.railway.app');
  assert.strictEqual(reg.isRegistered('eukolaki.gr'), true);
  assert.strictEqual(reg.isRegistered('nonexistent.gr'), false);
});

test('Railway Registry: should get registrations by status', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  reg.register('eukolaki.gr', 'dep_abc123', 'https://eukolaki-gr.up.railway.app', 'active');
  reg.register('www.eukolaki.gr', 'dep_def456', 'https://www-eukolaki-gr.up.railway.app', 'pending');
  const active = reg.getByStatus('active');
  assert.strictEqual(Object.keys(active).length, 1);
  assert(active['eukolaki.gr']);
});

test('Railway Registry: should get registrations for tenant', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  reg.register('eukolaki.gr', 'dep_abc123', 'https://eukolaki-gr.up.railway.app');
  reg.register('www.eukolaki.gr', 'dep_def456', 'https://www-eukolaki-gr.up.railway.app');
  const forTenant = reg.getForTenant('eukolaki.gr', ['www.eukolaki.gr']);
  assert.strictEqual(Object.keys(forTenant).length, 2);
});

test('Railway Registry: should persist registrations to disk', () => {
  cleanup();
  let reg = new RailwayRegistry(tmpFile);
  reg.register('eukolaki.gr', 'dep_abc123', 'https://eukolaki-gr.up.railway.app');

  // Create new instance and verify data persisted
  reg = new RailwayRegistry(tmpFile);
  assert.strictEqual(reg.get('eukolaki.gr').deploymentId, 'dep_abc123');
});

test('Railway Registry: should require domain, deploymentId, and url for registration', () => {
  cleanup();
  const reg = new RailwayRegistry(tmpFile);
  assert.throws(() => reg.register('', 'dep_abc123', 'https://...'));
  assert.throws(() => reg.register('eukolaki.gr', '', 'https://...'));
  assert.throws(() => reg.register('eukolaki.gr', 'dep_abc123', ''));
});

// ── Domain Provisioning Schema Tests ─────────────────────────────────────────
test('Domain Provisioning: should initialize domainProvisioning with required structure', () => {
  const tenant = {
    id: 'eukolakis',
    primaryDomain: 'eukolaki.gr',
    domain: 'eukolaki.gr',
    domains: ['www.eukolaki.gr']
  };

  // Simulate migration logic
  const primaryDomain = tenant.primaryDomain || tenant.domain || '';
  const aliases = Array.isArray(tenant.domains) ? [...tenant.domains] : [];

  const domainProvisioning = {
    primaryDomain: primaryDomain ? {
      domain: primaryDomain,
      status: 'active',
      dnsCheckResult: null,
      railwayDeploymentId: null,
      sslCertificateId: null,
      lastUpdatedAt: new Date().toISOString()
    } : null,
    aliases: aliases.map((domain) => ({
      domain,
      status: 'active',
      dnsCheckResult: null,
      railwayDeploymentId: null,
      sslCertificateId: null,
      lastUpdatedAt: new Date().toISOString()
    }))
  };

  assert.strictEqual(domainProvisioning.primaryDomain.domain, 'eukolaki.gr');
  assert.strictEqual(domainProvisioning.primaryDomain.status, 'active');
  assert.strictEqual(domainProvisioning.aliases.length, 1);
  assert.strictEqual(domainProvisioning.aliases[0].domain, 'www.eukolaki.gr');
});

test('Domain Provisioning: should initialize mailHosting with required structure', () => {
  const mailHosting = {
    mailProvider: null,
    mxRecords: [],
    spfRecord: null,
    dkimRecords: [],
    dmarcRecord: null
  };

  assert.strictEqual(mailHosting.mailProvider, null);
  assert.deepStrictEqual(mailHosting.mxRecords, []);
  assert.deepStrictEqual(mailHosting.dkimRecords, []);
});

test('Domain Provisioning: should initialize web3Config with required structure', () => {
  const web3Config = {
    web3Enabled: false,
    web3Host: null,
    ipfsGateway: null,
    dnslinkTxt: null
  };

  assert.strictEqual(web3Config.web3Enabled, false);
  assert.strictEqual(web3Config.web3Host, null);
  assert.strictEqual(web3Config.ipfsGateway, null);
});

test('Domain Provisioning: should preserve legacy domainStatus during migration', () => {
  const tenant = {
    id: 'eukolakis',
    primaryDomain: 'eukolaki.gr',
    domain: 'eukolaki.gr',
    domainStatus: 'ssl_validating' // legacy field
  };

  const legacyStatus = tenant.domainStatus || 'pending_dns';
  assert.strictEqual(legacyStatus, 'ssl_validating');
});

// ── DNS Check Structure Tests ────────────────────────────────────────────────
test('DNS Check: requiredRecords should have apex, txt, and aliases sections', () => {
  const requiredRecords = {
    apex: {
      type: 'CNAME',
      target: 'up.railway.app',
      description: 'Primary domain must point to Thronos Railway deployment'
    },
    txt: {
      type: 'TXT',
      location: 'eukolaki.gr',
      value: 'thronos-verify=eukolakis',
      description: 'Ownership verification record'
    },
    aliases: [
      {
        domain: 'www.eukolaki.gr',
        type: 'CNAME',
        target: 'up.railway.app',
        description: 'Alias must have real CNAME to Thronos'
      }
    ]
  };

  assert(requiredRecords.apex);
  assert(requiredRecords.txt);
  assert(Array.isArray(requiredRecords.aliases));
  assert.strictEqual(requiredRecords.apex.type, 'CNAME');
  assert.strictEqual(requiredRecords.txt.type, 'TXT');
});

test('DNS Check: detectedRecords should have apex, txt, and aliases sections', () => {
  const detectedRecords = {
    apex: {
      type: 'CNAME',
      targets: ['thronos-commerce-prod.up.railway.app'],
      verified: true
    },
    txt: {
      location: 'root',
      value: 'thronos-verify=eukolakis',
      verified: true
    },
    aliases: [
      {
        domain: 'www.eukolaki.gr',
        type: 'CNAME',
        targets: ['thronos-commerce-prod.up.railway.app'],
        verified: true
      }
    ]
  };

  assert(detectedRecords.apex);
  assert(detectedRecords.txt);
  assert(Array.isArray(detectedRecords.aliases));
  assert.strictEqual(detectedRecords.apex.type, 'CNAME');
  assert.strictEqual(detectedRecords.txt.location, 'root');
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passedCount}/${testCount} tests passed`);
process.exit(passedCount === testCount ? 0 : 1);
