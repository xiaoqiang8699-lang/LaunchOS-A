import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, 'packages/database/.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
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
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential } = requireApi('@launchos/shared');
const prisma = new PrismaClient();

function redactUrl(url) {
  return String(url || '').replace(/:([^:@/]+)@/, ':***@');
}

const routes = await prisma.gatewayRoute.findMany({
  select: {
    id: true,
    hostname: true,
    targetHost: true,
    targetPort: true,
    status: true,
    healthPath: true,
  },
  orderBy: { hostname: 'asc' },
});

const servers = await prisma.serverInstance.findMany({
  take: 30,
  select: {
    id: true,
    host: true,
    status: true,
    provider: true,
    name: true,
    scope: true,
    port: true,
    metadata: true,
  },
});

const dnsAccounts = await prisma.providerAccount.findMany({
  where: { type: { in: ['ALIYUN_DNS', 'ALIYUN'] } },
  select: { id: true, type: true, name: true, status: true, workspaceId: true },
});

let dnsProbe = null;
try {
  const account = await prisma.providerAccount.findFirst({
    where: { type: 'ALIYUN_DNS', status: 'READY' },
  });
  if (account?.encryptedSecrets) {
    const { AlibabaCloudDnsProvider } = requireApi('@launchos/domain');
    const raw = JSON.parse(decryptCredential(account.encryptedSecrets));
    const dns = new AlibabaCloudDnsProvider(
      { accessKey: raw.accessKey, secretKey: raw.secretKey },
      'zsaos.com',
    );
    const alpha = await dns.findARecordsReadOnly('alpha');
    const apiAlpha = await dns.findARecordsReadOnly('api-alpha');
    const web = await dns.findARecordsReadOnly('web-launchos');
    dnsProbe = {
      alpha: alpha.map((r) => ({ rr: r.rr, value: r.value, recordId: r.recordId })),
      apiAlpha: apiAlpha.map((r) => ({ rr: r.rr, value: r.value, recordId: r.recordId })),
      webLaunchos: web.map((r) => ({ rr: r.rr, value: r.value, recordId: r.recordId })),
    };
  }
} catch (error) {
  dnsProbe = { error: error instanceof Error ? error.message : String(error) };
}

console.log(
  JSON.stringify(
    {
      database: redactUrl(process.env.DATABASE_URL),
      redis: redactUrl(process.env.REDIS_URL),
      routes,
      servers,
      dnsAccounts: dnsAccounts.map((a) => ({
        id: a.id,
        type: a.type,
        name: a.name,
        status: a.status,
      })),
      dnsProbe,
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
