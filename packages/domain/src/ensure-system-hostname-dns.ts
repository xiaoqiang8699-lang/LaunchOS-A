/**
 * Step 35 — ensure public hostname A record points at Gateway public IP,
 * then require real DNS propagation (no --resolve bypass).
 */
import {
  ApplicationDnsStatus,
  PrismaClient,
  type ApplicationDomain,
} from '@launchos/database';
import { decryptCredential } from '@launchos/shared';
import { AlibabaCloudDnsProvider } from './alibaba-dns-provider.js';
import { readGatewayPublicIp, readSystemDomainZone } from './constants.js';
import { verifyHostnamePointsToIp } from './dns-verify.js';
import { verifyPublicHttps, type PublicHttpsVerifyResult } from './launch-https-verify.js';

function parseAliyunSecrets(raw: string): { accessKey: string; secretKey: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed) as { accessKey?: string; secretKey?: string };
    if (!json.accessKey || !json.secretKey) {
      throw new Error('DNS 凭证 JSON 缺少 accessKey/secretKey');
    }
    return { accessKey: json.accessKey, secretKey: json.secretKey };
  }
  const [accessKey, secretKey] = trimmed.split(':');
  if (!accessKey || !secretKey) {
    throw new Error('DNS 凭证格式无效');
  }
  return { accessKey, secretKey };
}

function hostnameToRr(hostname: string, rootDomain: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  const zone = rootDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!host || !zone) return null;
  if (host === zone) return null;
  if (!host.endsWith(`.${zone}`)) return null;
  const rr = host.slice(0, -(zone.length + 1));
  if (!rr || rr.includes('.')) return null;
  return rr;
}

export async function loadSystemAliyunDns(prisma: PrismaClient): Promise<{
  provider: AlibabaCloudDnsProvider;
  rootDomain: string;
  gatewayPublicIp: string;
} | null> {
  const config = await prisma.systemDomainConfig.findFirst({
    orderBy: { createdAt: 'asc' },
  });
  if (!config?.dnsProviderAccountId) {
    return null;
  }
  const rootDomain = (readSystemDomainZone() || config.rootDomain || '').trim().toLowerCase();
  const gatewayPublicIp =
    readGatewayPublicIp() || config.gatewayPublicIp?.trim() || '';
  if (!rootDomain || !gatewayPublicIp) {
    return null;
  }
  const account = await prisma.providerAccount.findUnique({
    where: { id: config.dnsProviderAccountId },
    include: { provider: true },
  });
  if (!account?.credentialEncrypted || account.provider.type !== 'ALIYUN_DNS') {
    return null;
  }
  if (account.status !== 'VERIFIED' && account.status !== 'ACTIVE') {
    return null;
  }
  const secrets = parseAliyunSecrets(decryptCredential(account.credentialEncrypted));
  return {
    provider: new AlibabaCloudDnsProvider(secrets, rootDomain),
    rootDomain,
    gatewayPublicIp,
  };
}

export async function ensureHostnameDnsToGateway(
  prisma: PrismaClient,
  hostname: string,
): Promise<{ ensured: boolean; detail: string; expectedIp: string | null }> {
  const loaded = await loadSystemAliyunDns(prisma);
  if (!loaded) {
    return {
      ensured: false,
      detail: 'DNS_PROVIDER_UNAVAILABLE',
      expectedIp: readGatewayPublicIp(),
    };
  }
  const rr = hostnameToRr(hostname, loaded.rootDomain);
  if (!rr) {
    return {
      ensured: false,
      detail: `HOSTNAME_NOT_UNDER_ZONE:${hostname}`,
      expectedIp: loaded.gatewayPublicIp,
    };
  }
  const record = await loaded.provider.upsertSystemAppARecord(rr, loaded.gatewayPublicIp);
  return {
    ensured: true,
    detail: `A ${rr}.${loaded.rootDomain}=${record.value} id=${record.recordId}`,
    expectedIp: loaded.gatewayPublicIp,
  };
}

export async function waitForHostnameDns(
  hostname: string,
  expectedIp: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ matched: boolean; addresses: string[]; detail: string }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const started = Date.now();
  let lastAddresses: string[] = [];
  while (Date.now() - started <= timeoutMs) {
    const lookup = await verifyHostnamePointsToIp(hostname, expectedIp);
    lastAddresses = lookup.addresses;
    if (lookup.matched) {
      return { matched: true, addresses: lookup.addresses, detail: 'DNS_MATCH' };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    matched: false,
    addresses: lastAddresses,
    detail: `DNS_PROPAGATION_TIMEOUT addresses=${lastAddresses.join(',') || 'none'}`,
  };
}

export async function verifyPublicEntryWithRetry(input: {
  hostname: string;
  path?: string;
  expectedIp: string;
  acceptStatuses?: number[];
  attempts?: number;
  backoffMs?: number;
}): Promise<PublicHttpsVerifyResult> {
  const path = input.path?.startsWith('/') ? input.path : `/${input.path || ''}`;
  const url = `https://${input.hostname}${path === '/' ? '/' : path}`;
  const attempts = input.attempts ?? 6;
  const backoffMs = input.backoffMs ?? 5_000;
  let last: PublicHttpsVerifyResult | null = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await verifyPublicHttps({
      hostname: input.hostname,
      url,
      expectedIp: input.expectedIp,
      acceptStatuses: input.acceptStatuses ?? [200, 201, 204, 301, 302, 307, 308],
    });
    if (last.ok) {
      return last;
    }
    if (i + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  return (
    last ?? {
      ok: false,
      hostname: input.hostname,
      url,
      dnsCorrect: false,
      dnsAddresses: [],
      tcp443: false,
      tlsOk: false,
      certificateValid: false,
      daysRemaining: null,
      httpStatus: null,
      failureCode: 'VERIFY_NO_ATTEMPT',
      failureMessage: 'verify_no_attempt',
      bodySnippetSafe: null,
    }
  );
}

export async function markDomainDnsFromPublicResolve(
  prisma: PrismaClient,
  domain: string,
  expectedIp: string,
): Promise<ApplicationDomain> {
  const normalized = domain.trim().toLowerCase();
  const lookup = await verifyHostnamePointsToIp(normalized, expectedIp);
  if (lookup.matched) {
    return prisma.applicationDomain.update({
      where: { domain: normalized },
      data: { dnsStatus: ApplicationDnsStatus.ACTIVE },
    });
  }
  // Never demote an already-ACTIVE binding because of transient resolver failure.
  const existing = await prisma.applicationDomain.findUnique({ where: { domain: normalized } });
  if (!existing) {
    throw new Error(`Domain ${normalized} not found`);
  }
  if (existing.dnsStatus === ApplicationDnsStatus.ACTIVE) {
    return existing;
  }
  return prisma.applicationDomain.update({
    where: { domain: normalized },
    data: { dnsStatus: ApplicationDnsStatus.PENDING },
  });
}

/**
 * Step 36 — reuse path: if hostname already resolves to gateway IP, DNS is ready.
 * First-time hostnames still need ensure + limited wait.
 */
export async function ensurePublicDnsReady(input: {
  prisma: PrismaClient;
  hostname: string;
  expectedIp: string;
  onLog?: (message: string) => void | Promise<void>;
  firstTimeTimeoutMs?: number;
}): Promise<{ reused: boolean; matched: boolean; detail: string; addresses: string[] }> {
  const hostname = input.hostname.trim().toLowerCase();
  const quick = await verifyHostnamePointsToIp(hostname, input.expectedIp);
  if (quick.matched) {
    await input.prisma.applicationDomain
      .update({
        where: { domain: hostname },
        data: { dnsStatus: ApplicationDnsStatus.ACTIVE },
      })
      .catch(() => undefined);
    await input.onLog?.(
      `[PUBLIC_DNS] REUSE_DOMAIN ${hostname} already resolves to ${input.expectedIp}`,
    );
    return {
      reused: true,
      matched: true,
      detail: 'REUSE_DOMAIN',
      addresses: quick.addresses,
    };
  }

  const dnsEnsure = await ensureHostnameDnsToGateway(input.prisma, hostname);
  await input.onLog?.(
    `[PUBLIC_DNS] ${hostname} ensure=${dnsEnsure.ensured} ${dnsEnsure.detail}`,
  );
  const waited = await waitForHostnameDns(hostname, input.expectedIp, {
    timeoutMs: input.firstTimeTimeoutMs ?? 180_000,
    intervalMs: 5_000,
  });
  if (waited.matched) {
    await input.prisma.applicationDomain
      .update({
        where: { domain: hostname },
        data: { dnsStatus: ApplicationDnsStatus.ACTIVE },
      })
      .catch(() => undefined);
  }
  return {
    reused: false,
    matched: waited.matched,
    detail: waited.detail,
    addresses: waited.addresses,
  };
}
