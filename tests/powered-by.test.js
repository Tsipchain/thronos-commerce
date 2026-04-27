const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors the footer logic from index.ejs so we can unit-test it without EJS.
function shouldShowPoweredBy(tenant, config) {
  const mode = (tenant && tenant.poweredByMode) ||
    (tenant && tenant.allowPoweredBy === true ? 'always' : 'disabled');
  if (mode === 'always') return true;
  if (mode === 'disabled') return false;
  // free_only: show when tenant has no subscriptionExpiry and config doesn't explicitly disable
  if (mode === 'free_only') {
    return !(tenant && tenant.subscriptionExpiry) &&
      (!config || !config.footer || config.footer.poweredByEnabled !== false);
  }
  return false;
}

function resolveLabel(tenant, config) {
  return (tenant && tenant.poweredByLabel) ||
    (config && config.footer && config.footer.poweredByText) ||
    'Powered by Thronos Chain ↗';
}

function resolveHref(tenant, config) {
  return (tenant && tenant.poweredByHref) ||
    (config && config.footer && config.footer.poweredByUrl) ||
    'https://thronoschain.org/';
}

// ── mode=disabled ─────────────────────────────────────────────────────────────

test('mode=disabled never shows', () => {
  assert.equal(shouldShowPoweredBy({ poweredByMode: 'disabled' }, {}), false);
});

test('legacy allowPoweredBy=false maps to disabled', () => {
  assert.equal(shouldShowPoweredBy({ allowPoweredBy: false }, {}), false);
});

test('no poweredBy fields at all: defaults to disabled', () => {
  assert.equal(shouldShowPoweredBy({}, {}), false);
});

// ── mode=always ───────────────────────────────────────────────────────────────

test('mode=always shows for paid tenant', () => {
  assert.equal(shouldShowPoweredBy({ poweredByMode: 'always', subscriptionExpiry: '2027-01-01' }, {}), true);
});

test('mode=always shows for free tenant', () => {
  assert.equal(shouldShowPoweredBy({ poweredByMode: 'always' }, {}), true);
});

test('legacy allowPoweredBy=true maps to always', () => {
  assert.equal(shouldShowPoweredBy({ allowPoweredBy: true }, {}), true);
});

// ── mode=free_only ────────────────────────────────────────────────────────────

test('mode=free_only shows for tenant without subscriptionExpiry', () => {
  assert.equal(shouldShowPoweredBy({ poweredByMode: 'free_only' }, {}), true);
});

test('mode=free_only hidden when tenant has subscriptionExpiry', () => {
  assert.equal(shouldShowPoweredBy({ poweredByMode: 'free_only', subscriptionExpiry: '2027-06-01' }, {}), false);
});

test('mode=free_only respects config.footer.poweredByEnabled=false', () => {
  assert.equal(shouldShowPoweredBy({ poweredByMode: 'free_only' }, { footer: { poweredByEnabled: false } }), false);
});

// ── label / href resolution ───────────────────────────────────────────────────

test('tenant.poweredByLabel overrides config.footer.poweredByText', () => {
  const label = resolveLabel(
    { poweredByLabel: 'Made with Thronos' },
    { footer: { poweredByText: 'Old text' } }
  );
  assert.equal(label, 'Made with Thronos');
});

test('config.footer.poweredByText used when no tenant override', () => {
  const label = resolveLabel({}, { footer: { poweredByText: 'By Thronos ↗' } });
  assert.equal(label, 'By Thronos ↗');
});

test('default label when nothing configured', () => {
  const label = resolveLabel({}, {});
  assert.equal(label, 'Powered by Thronos Chain ↗');
});

test('tenant.poweredByHref overrides config.footer.poweredByUrl', () => {
  const href = resolveHref(
    { poweredByHref: 'https://custom.example.com' },
    { footer: { poweredByUrl: 'https://old.example.com' } }
  );
  assert.equal(href, 'https://custom.example.com');
});

test('default href when nothing configured', () => {
  const href = resolveHref({}, {});
  assert.equal(href, 'https://thronoschain.org/');
});
