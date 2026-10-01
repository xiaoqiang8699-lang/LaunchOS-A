/**
 * Read-only orphan check for a specific CloudResource. No CreateInstance.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
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

const CR = process.argv[2] || 'cmu4xn1j60001riaw6gjh0rfn';
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudRedisProvider } = require(resolve(root, 'packages/providers/dist/index.js'));

const prisma = new PrismaClient();
const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
const meta = cr?.metadata || {};
const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
});
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const region = cr?.region || 'cn-hangzhou';
const provider = new AlibabaCloudRedisProvider({
  accessKey: secrets.accessKey,
  secretKey: secrets.secretKey,
  region,
});
const instanceName = String(meta.instanceName || 'launchos-launchos');
const ids = await provider.listInstancesByName(region, instanceName);

console.log(
  JSON.stringify(
    {
      cloudResourceId: CR,
      providerResourceId: cr?.providerResourceId ?? null,
      createInstanceAttemptCount: meta.createInstanceAttemptCount ?? 0,
      createInstanceSuccessCount: meta.createInstanceSuccessCount ?? 0,
      technicalMessage: meta.technicalMessage ?? null,
      providerErrorCode: meta.providerErrorCode ?? null,
      providerRequestId: meta.providerRequestId ?? null,
      errorCode: meta.errorCode ?? null,
      errorMessage: meta.errorMessage ?? null,
      reconcile: {
        region,
        instanceName,
        operationId: meta.operationId ?? null,
        matchCount: ids.length,
        instanceIds: ids,
        verdict:
          ids.length === 0
            ? '0 → no instance created'
            : ids.length === 1
              ? '1 → claim'
              : '>1 → REDIS_RECONCILE_AMBIGUOUS',
      },
      providerAttemptNow: provider.createInstanceAttemptCount,
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
