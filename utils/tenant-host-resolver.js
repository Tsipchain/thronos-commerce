const PLATFORM_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  'thronoscommerce.thronoschain.org',
  'thonoscommerce.thronoschain.org'
]);

function normalizeHost(rawHost) {
  const host = String(rawHost || '').trim().toLowerCase();
  if (!host) return '';
  return host.split(':')[0];
}

function hostCandidates(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return [];
  if (normalized.startsWith('www.')) return [normalized, normalized.slice(4)];
  return [normalized, `www.${normalized}`];
}

function matchesPlatformHost(host) {
  if (!host) return false;
  if (PLATFORM_HOSTS.has(host)) return true;
  if (host.endsWith('.up.railway.app')) return true;
  if (host.endsWith('.railway.internal')) return true;
  return false;
}

function tenantHostnames(tenant) {
  const hosts = new Set();
  const add = (value) => {
    const h = normalizeHost(value);
    if (h) hosts.add(h);
  };
  if (!tenant || typeof tenant !== 'object') return hosts;
  add(tenant.domain);
  add(tenant.primaryDomain);
  if (Array.isArray(tenant.domains)) tenant.domains.forEach(add);
  if (tenant.previewSubdomain) {
    const sub = String(tenant.previewSubdomain).trim().toLowerCase();
    if (sub) {
      add(`${sub}.thronoscommerce.thronoschain.org`);
      add(`${sub}.thonoscommerce.thronoschain.org`);
    }
  }
  if (tenant.id) {
    const id = String(tenant.id).trim().toLowerCase();
    if (id) {
      add(`${id}.thronoscommerce.thronoschain.org`);
      add(`${id}.thonoscommerce.thronoschain.org`);
    }
  }
  return hosts;
}

function resolveTenantFromHost(rawHost, tenants) {
  const normalizedHost = normalizeHost(rawHost);
  if (!normalizedHost) return { type: 'unknown', normalizedHost, reason: 'empty_host' };
  if (matchesPlatformHost(normalizedHost)) return { type: 'platform', normalizedHost, reason: 'platform_host' };
  const list = Array.isArray(tenants) ? tenants : [];
  const candidates = hostCandidates(normalizedHost);
  for (const tenant of list) {
    const mapped = tenantHostnames(tenant);
    for (const c of candidates) {
      if (mapped.has(c)) {
        return { type: 'tenant', tenant, normalizedHost, matchedHost: c, reason: 'tenant_host_match' };
      }
    }
  }
  return { type: 'unknown', normalizedHost, reason: 'unmapped_host' };
}

module.exports = {
  PLATFORM_HOSTS,
  normalizeHost,
  tenantHostnames,
  resolveTenantFromHost
};
