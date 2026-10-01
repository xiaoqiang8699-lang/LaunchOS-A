/** Development-only fallback. Prefer LAUNCHOS_SYSTEM_DOMAIN in all environments. */
export const DEV_DEFAULT_SYSTEM_DOMAIN = 'launchos.app';

/** @deprecated Use readSystemDomainZone / LAUNCHOS_SYSTEM_DOMAIN */
export const SYSTEM_DOMAIN_ZONE = DEV_DEFAULT_SYSTEM_DOMAIN;

/**
 * System root domain for branded app hosts: {slug}.{rootDomain}
 * Env: LAUNCHOS_SYSTEM_DOMAIN (preferred), LAUNCHOS_DOMAIN_ZONE (legacy alias)
 */
export function readSystemDomainZone(): string {
  const preferred = process.env.LAUNCHOS_SYSTEM_DOMAIN?.trim();
  if (preferred) {
    return preferred.toLowerCase().replace(/^\.+|\.+$/g, '');
  }
  const legacy = process.env.LAUNCHOS_DOMAIN_ZONE?.trim();
  if (legacy) {
    return legacy.toLowerCase().replace(/^\.+|\.+$/g, '');
  }
  return DEV_DEFAULT_SYSTEM_DOMAIN;
}

export function readGatewayPublicIp(): string | null {
  const value =
    process.env.LAUNCHOS_GATEWAY_PUBLIC_IP?.trim() ||
    process.env.GATEWAY_PUBLIC_IP?.trim() ||
    '';
  return value.length > 0 ? value : null;
}

export function readGatewayServerId(): string | null {
  const value = process.env.LAUNCHOS_GATEWAY_SERVER_ID?.trim() || '';
  return value.length > 0 ? value : null;
}

export function readGatewayHttpPort(): number {
  const raw = Number(process.env.GATEWAY_HTTP_PORT);
  if (Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  // Public system entry prefers 80; local dev often overrides to 8080.
  return 80;
}

export function readGatewayHttpsPort(): number {
  const raw = Number(process.env.GATEWAY_HTTPS_PORT);
  if (Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  return 8443;
}

export function readGatewayRoutesFile(): string | null {
  const value = process.env.GATEWAY_ROUTES_FILE?.trim() || '';
  return value.length > 0 ? value : null;
}

export function toHostLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Step 23.3: https when SSL ACTIVE; otherwise http until Step 23.3 complete */
export function brandedVisitUrl(domain: string, sslActive = false): string {
  const scheme = sslActive ? 'https' : 'http';
  return `${scheme}://${domain}`;
}

export function toVisitUrls(record: {
  domain: string;
  status: string;
  sslStatus?: string;
  dnsStatus?: string;
}): {
  visitUrl: string | null;
  localVisitUrl: string | null;
  dnsReady: boolean;
  gatewayReady: boolean;
} {
  const gatewayReady = record.status === 'ACTIVE';
  const dnsReady = record.dnsStatus === 'ACTIVE';
  const sslReady = record.sslStatus === 'ACTIVE';
  if (!gatewayReady) {
    return { visitUrl: null, localVisitUrl: null, dnsReady: false, gatewayReady: false };
  }
  return {
    visitUrl: brandedVisitUrl(record.domain, sslReady),
    // Public DNS ready → open system domain only (no localhost Gateway fallback).
    localVisitUrl: dnsReady ? null : localGatewayVisitUrl(record.domain),
    dnsReady,
    gatewayReady: true,
  };
}

export function localGatewayVisitUrl(domain: string): string {
  const label = domain.split('.')[0] || 'app';
  const port = readGatewayHttpPort();
  const suffix = port === 80 ? '' : `:${port}`;
  return `http://${label}.localhost${suffix}/`;
}

export function systemDomainFromSlug(slug: string, zone = readSystemDomainZone()): string {
  const label = toHostLabel(slug) || 'app';
  return `${label}.${zone}`;
}

export function canonicalSystemDomain(hostname: string, zone = readSystemDomainZone()): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '').split(':')[0] ?? '';
  if (!host) {
    return null;
  }
  if (host.endsWith(`.${zone}`) || host === zone) {
    return host;
  }
  if (host.endsWith('.localhost') || host === 'localhost') {
    const label = host.replace(/\.localhost$/, '');
    if (!label || label === 'localhost') {
      return null;
    }
    return `${label}.${zone}`;
  }
  return null;
}
