/**
 * Read-only CR + unit snapshot for Step 25.4 resume.
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
const API_UNIT = 'cmu3j272x0005ri7wlxlbajeu';
const WEB_UNIT = 'cmu3j27340007ri7wcno1xrai';
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudRedisProvider } = require(resolve(root, 'packages/providers/dist/index.js'));

const prisma = new PrismaClient();
try {
  const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
  const m = cr?.metadata && typeof cr.metadata === 'object' ? cr.metadata : {};
  const units = await prisma.deployableUnit.findMany({
    where: { id: { in: [API_UNIT, WEB_UNIT] } },
    select: {
      id: true,
      name: true,
      type: true,
      configRevision: true,
    },
  });
  const account = await prisma.providerAccount.findFirst({
    where: { status: 'ACTIVE', provider: { type: 'ALIYUN' }, workspaceId: cr.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const provider = new AlibabaCloudRedisProvider({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region: cr.region || 'cn-hangzhou',
  });
  const status = cr.providerResourceId
    ? await provider.getInstanceStatus(cr.providerResourceId)
    : null;
  const ids = await provider.listInstancesByName(
    cr.region || 'cn-hangzhou',
    String(m.instanceName || 'launchos-launchos'),
  );
  const conn = await prisma.redisConnection.findFirst({
    where: { cloudResourceId: CR },
    select: { id: true, host: true, port: true, source: true, status: true },
  });
  const runtime = await prisma.runtimeConfigValue.findMany({
    where: {
      deployableUnitId: { in: [API_UNIT, WEB_UNIT] },
      key: 'REDIS_URL',
    },
    select: {
      id: true,
      deployableUnitId: true,
      key: true,
      provider: true,
      providerRef: true,
      isSensitive: true,
    },
  });

  console.log(
    JSON.stringify(
      {
        cloudResourceId: CR,
        status: cr?.status,
        providerResourceId: cr?.providerResourceId,
        createInstanceCompleted: m.createInstanceCompleted === true,
        createGeneration: m.createGeneration,
        counters: {
          attempt: m.createInstanceAttemptCount,
          success: m.createInstanceSuccessCount,
          genAttempt: m.generationAttemptCount,
          genSuccess: m.generationSuccessCount,
        },
        unitIds: m.unitIds,
        serverInstanceId: m.serverInstanceId,
        passwordConfigured: Boolean(m.passwordEncrypted),
        instanceStatus: status,
        reconcileIds: ids,
        redisConnection: conn,
        redisUrlBindings: runtime,
        units,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
