const PLATFORM_HOSTS = new Set([
  'thronoscommerce.thronoschain.org',
  'thonoscommerce.thronoschain.org',
  'localhost',
  '127.0.0.1'
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
  const add = (v) => {
    const n = normalizeHost(v);
    if (n) hosts.add(n);
  };
  if (!tenant || typeof tenant !== 'object') return hosts;
  add(tenant.primaryDomain);
  add(tenant.domain);
  if (Array.isArray(tenant.domains)) tenant.domains.forEach(add);
  if (tenant.previewSubdomain) {
    const preview = String(tenant.previewSubdomain).trim().toLowerCase();
    if (preview) {
      add(`${preview}.thronoscommerce.thronoschain.org`);
      add(`${preview}.thonoscommerce.thronoschain.org`);
    }
  }
  if (tenant.id) {
    const tid = String(tenant.id).trim().toLowerCase();
    if (tid) {
      add(`${tid}.thronoscommerce.thronoschain.org`);
      add(`${tid}.thonoscommerce.thronoschain.org`);
    }
  }
  return hosts;
}

function resolveTenantFromHost(rawHost, tenants) {
  const normalizedHost = normalizeHost(rawHost);
  const candidates = hostCandidates(normalizedHost);
  if (!normalizedHost) {
    return { type: 'unknown', normalizedHost, reason: 'empty_host' };
  }
  if (matchesPlatformHost(normalizedHost)) {
    return { type: 'platform', normalizedHost, reason: 'platform_host' };
  }
  const list = Array.isArray(tenants) ? tenants : [];
  for (const tenant of list) {
    const mappedHosts = tenantHostnames(tenant);
    for (const c of candidates) {
      if (mappedHosts.has(c)) {
        return {
          type: 'tenant',
          tenant,
          normalizedHost,
          matchedHost: c,
          reason: 'tenant_host_match'
        };
      }
    }
  }
  return { type: 'unknown', normalizedHost, reason: 'unmapped_host' };
}

module.exports = {
  PLATFORM_HOSTS,
  normalizeHost,
  resolveTenantFromHost
};
