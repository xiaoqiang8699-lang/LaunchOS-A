/**
 * Inspect PAYMENT_TEST pending orders (no secrets).
 * node scripts/_tmp-m8-1a-pending-inspect.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const WS = 'cmunqotx500cbrl013xbhpio2';
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { id: 'cmuma9i480001rij49yv4yw2q' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});

const sql = `
SELECT p.id
  || '|' || p.status
  || '|' || COALESCE(p."merchantOrderNo",'')
  || '|' || COALESCE(p."providerTradeNo",'')
  || '|' || COALESCE(p."amountCents"::text,'')
  || '|' || CASE WHEN COALESCE(p."providerCheckoutId",'')<>'' THEN '1' ELSE '0' END
  || '|' || CASE WHEN COALESCE(p."providerRequestId",'')<>'' THEN '1' ELSE '0' END
  || '|' || p."createdAt"::text
  || '|' || COALESCE(p."lastQueryState",'')
  || '|' || COALESCE(p."failureCode",'')
  || '|' || o.id
  || '|' || o.status
  || '|' || COALESCE(o."orderNumber",'')
  || '|' || COALESCE(pl.code,'')
  || '|' || COALESCE(p."isProductionTest"::text,'')
FROM "Payment" p
JOIN "CommercialOrder" o ON o.id=p."orderId"
JOIN "Plan" pl ON pl.id=o."planId"
WHERE o."workspaceId"='${WS}'
  AND (pl.code='PAYMENT_TEST' OR p."isProductionTest"=true)
ORDER BY p."createdAt" DESC
LIMIT 20
`.replace(/\n/g, ' ');

const q = await runner.execute(
  shellCommand(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(sql)}`),
  { timeoutMs: 20000 },
);

const lines = String(q.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const rows = lines.map((line) => {
  const p = line.split('|');
  return {
    paymentOrderId: p[0],
    status: p[1],
    outTradeNo: p[2],
    providerTradeNoPresent: Boolean(p[3]),
    amountCents: p[4],
    checkoutIdPresent: p[5] === '1',
    requestIdPresent: p[6] === '1',
    createdAt: p[7],
    lastQueryState: p[8] || null,
    failureCode: p[9] || null,
    commercialOrderId: p[10],
    orderStatus: p[11],
    orderNumber: p[12],
    planCode: p[13],
    isProductionTest: p[14],
  };
});

const pending = rows.filter((r) => r.status === 'PENDING' || r.status === 'PROCESSING');
const report = {
  PENDING_PAYMENT_TEST_COUNT: pending.length,
  pending,
  all: rows,
};
writeFileSync(join(ARTIFACT, 'm8-1a-pending-inspect.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await runner.disconnect();
await prisma.$disconnect();
