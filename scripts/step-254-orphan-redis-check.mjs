/**
 * Read-only orphan Redis check for Step 25.4. No CreateInstance.
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

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudRedisProvider } = require(resolve(root, 'packages/providers/dist/index.js'));

const FAILED_CR_ID = 'cmu4x1saf0001riw0gpv7in0c';
const prisma = new PrismaClient();

const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
});
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const region = account.region || 'cn-hangzhou';
const provider = new AlibabaCloudRedisProvider({
  accessKey: secrets.accessKey,
  secretKey: secrets.secretKey,
  region,
});

const cr = await prisma.cloudResource.findUnique({
  where: { id: FAILED_CR_ID },
  select: {
    id: true,
    status: true,
    providerResourceId: true,
    externalId: true,
    metadata: true,
    createdAt: true,
    region: true,
  },
});

const meta = cr?.metadata && typeof cr.metadata === 'object' ? cr.metadata : {};
const instanceName =
  (typeof meta.instanceName === 'string' && meta.instanceName) ||
  (typeof meta.suggestedInstanceName === 'string' && meta.suggestedInstanceName) ||
  '';

const byName = instanceName
  ? await provider.listInstancesByName(region, instanceName)
  : [];

console.log(
  JSON.stringify(
    {
      mode: 'ORPHAN_CHECK_READONLY',
      failedCloudResource: {
        id: cr?.id,
        status: cr?.status,
        providerResourceId: cr?.providerResourceId,
        externalId: cr?.externalId,
        instanceName,
        createInstanceCallCount: meta.createInstanceCallCount ?? 0,
        createInstanceCompleted: meta.createInstanceCompleted ?? false,
      },
      describeInstancesByName: {
        region,
        instanceName,
        count: byName.length,
        ids: byName,
        verdict: byName.length === 0 ? '0 → continue' : byName.length === 1 ? '1 → claim' : '>1 → ambiguous stop',
      },
      providerCreateInstanceCallCount: provider.createInstanceCallCount,
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
