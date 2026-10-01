import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const p = new PrismaClient();

const dns = await p.providerAccount.findMany({
  where: { provider: { type: 'ALIYUN_DNS' } },
  select: {
    id: true,
    status: true,
    label: true,
    provider: { select: { type: true } },
    credentialEncrypted: true,
  },
  take: 5,
});
const sys = await p.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } });
const appDomains = await p.applicationDomain.findMany({
  where: { projectId: 'cmu3j24mv0001ri7wcsoa30hj' },
  select: {
    id: true,
    domain: true,
    status: true,
    type: true,
    deployableUnitId: true,
    sslStatus: true,
    dnsStatus: true,
    runtimeHost: true,
    runtimePort: true,
  },
  take: 20,
});
const webReqs = await p.runtimeConfigRequirement.findMany({
  where: { deployableUnitId: 'cmu3j27340007ri7wcno1xrai' },
  select: { key: true, injectionPhase: true, required: true, status: true },
});

console.log(
  JSON.stringify(
    {
      dns: dns.map((d) => ({
        id: d.id,
        status: d.status,
        type: d.provider.type,
        label: d.label,
        hasEnc: Boolean(d.credentialEncrypted),
      })),
      sys: sys
        ? {
            rootDomain: sys.rootDomain,
            gatewayPublicIp: sys.gatewayPublicIp,
            gatewayServerId: sys.gatewayServerId,
            tlsStatus: sys.tlsStatus,
            tlsCertificateDomain: sys.tlsCertificateDomain,
            tlsIssuer: sys.tlsIssuer,
            tlsExpiresAt: sys.tlsExpiresAt,
            tlsCertPathHint: sys.tlsCertPathHint,
            dnsProvider: sys.dnsProvider,
            dnsProviderAccountId: sys.dnsProviderAccountId,
          }
        : null,
      appDomains,
      webReqs,
    },
    null,
    2,
  ),
);
await p.$disconnect();
