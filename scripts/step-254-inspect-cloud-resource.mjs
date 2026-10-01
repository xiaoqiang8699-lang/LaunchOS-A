/**
 * Read-only inspect for Step 25.4 SKU loss diagnosis. No CreateInstance.
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

const CR_ID = process.argv[2] || 'cmu4xn1j60001riaw6gjh0rfn';
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const Redis = createRequire(resolve(root, 'apps/api/package.json'))('ioredis');
const prisma = new PrismaClient();

const cr = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
const meta = cr?.metadata && typeof cr.metadata === 'object' ? cr.metadata : {};
const safeKeys = [
  'tier',
  'instanceClass',
  'engineVersion',
  'storageType',
  'capacityMb',
  'zoneId',
  'zone',
  'productType',
  'architecture',
  'architectureType',
  'selectionReason',
  'resolvedSku',
  'availabilityFingerprint',
  'networkMode',
  'phase',
  'errorCode',
  'technicalMessage',
  'createInstanceCallCount',
  'createInstanceAttemptCount',
  'createInstanceSuccessCount',
  'createInstanceCompleted',
  'instanceName',
  'region',
  'operationId',
  'vpcId',
  'vSwitchId',
];
const safeMeta = {};
for (const k of safeKeys) {
  if (meta[k] !== undefined) safeMeta[k] = meta[k];
}

let jobPayload = null;
let jobMeta = null;
try {
  const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 1,
  });
  const jobId = `redis-provision-${CR_ID}`;
  const raw = await redis.hgetall(`bull:redisProvisionQueue:${jobId}`);
  jobMeta = {
    jobId,
    hashKeys: Object.keys(raw || {}),
    attemptsMade: raw?.attemptsMade ?? null,
    finishedOn: raw?.finishedOn ?? null,
    processedOn: raw?.processedOn ?? null,
    failedReason: (raw?.failedReason || '').slice(0, 400),
  };
  if (raw?.data) {
    try {
      jobPayload = JSON.parse(raw.data);
    } catch {
      jobPayload = raw.data;
    }
  }
  await redis.quit();
} catch (e) {
  jobPayload = { error: String(e?.message || e) };
}

console.log(
  JSON.stringify(
    {
      cloudResource: {
        id: cr?.id,
        status: cr?.status,
        providerResourceId: cr?.providerResourceId,
        externalId: cr?.externalId,
        region: cr?.region,
        instanceType: cr?.instanceType,
        createdAt: cr?.createdAt,
      },
      safeMetadata: safeMeta,
      metadataKeys: Object.keys(meta).filter((k) => !/password|secret|token|credential/i.test(k)),
      queueJob: { payload: jobPayload, ...jobMeta },
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
