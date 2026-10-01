import { randomBytes } from 'node:crypto';

export type DnsLookupResult = {
  hostname: string;
  addresses: string[];
  matched: boolean;
  error?: string;
};

export type WildcardDnsVerifyResult = {
  expectedIp: string;
  rootDomain: string;
  samples: DnsLookupResult[];
  verified: boolean;
};

type DohAnswer = { data?: string; type?: number };

/**
 * Resolve A records via DNS-over-HTTPS first, then fall back to system DNS.
 * Alpha China nodes often cannot reach Google/Cloudflare DoH; system dig still works.
 */
async function resolve4Public(hostname: string): Promise<string[]> {
  const endpoints = [
    `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
  ];
  let lastError: unknown;
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        throw new Error(`DoH HTTP ${response.status}`);
      }
      const json = (await response.json()) as { Answer?: DohAnswer[]; Status?: number };
      if (json.Status !== 0 && json.Status !== undefined && !json.Answer?.length) {
        throw new Error(`DoH status ${json.Status}`);
      }
      const addresses = (json.Answer ?? [])
        .filter((item) => item.type === 1 && typeof item.data === 'string')
        .map((item) => item.data as string);
      if (addresses.length === 0) {
        throw new Error('DoH returned no A records');
      }
      return addresses;
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const { resolve4 } = await import('node:dns/promises');
    const addresses = await resolve4(hostname);
    if (addresses.length > 0) {
      return addresses;
    }
  } catch (error) {
    lastError = error;
  }

  try {
    const { spawnSync } = await import('node:child_process');
    const dig = spawnSync('dig', ['+short', hostname, 'A'], {
      encoding: 'utf8',
      timeout: 8_000,
    });
    const addresses = String(dig.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d{1,3}(\.\d{1,3}){3}$/.test(line));
    if (addresses.length > 0) {
      return addresses;
    }
  } catch (error) {
    lastError = error;
  }

  throw lastError instanceof Error ? lastError : new Error('DNS resolve failed');
}

export async function resolveHostnameIpv4(hostname: string): Promise<DnsLookupResult> {
  try {
    const addresses = await resolve4Public(hostname);
    return {
      hostname,
      addresses,
      matched: false,
    };
  } catch (error) {
    return {
      hostname,
      addresses: [],
      matched: false,
      error: error instanceof Error ? error.message : 'DNS resolve failed',
    };
  }
}

export async function verifyHostnamePointsToIp(
  hostname: string,
  expectedIp: string,
): Promise<DnsLookupResult> {
  const result = await resolveHostnameIpv4(hostname);
  return {
    ...result,
    matched: result.addresses.includes(expectedIp),
  };
}

/**
 * Wildcard DNS check: two random subdomains must resolve to Gateway public IP.
 */
export async function verifyWildcardDns(
  rootDomain: string,
  expectedIp: string,
): Promise<WildcardDnsVerifyResult> {
  const zone = rootDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  const a = `dns-check-a-${randomBytes(3).toString('hex')}.${zone}`;
  const b = `dns-check-b-${randomBytes(3).toString('hex')}.${zone}`;
  const samples = await Promise.all([
    verifyHostnamePointsToIp(a, expectedIp),
    verifyHostnamePointsToIp(b, expectedIp),
  ]);
  return {
    expectedIp,
    rootDomain: zone,
    samples,
    verified: samples.every((item) => item.matched),
  };
}
