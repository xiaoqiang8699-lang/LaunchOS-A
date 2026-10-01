/**
 * Claim orphan Redis found by reconcile after CreateInstance ConnectTimeout.
 * Does NOT CreateInstance. Does NOT enqueue.
 *
 *   node scripts/step-254-claim-reconcile-instance.mjs [cloudResourceId]
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
const APPLY = process.argv.includes('--apply');

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const shared = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudRedisProvider } = require(resolve(root, 'packages/providers/dist/index.js'));
const {
  decryptCredential,
  parseAliyunRedisProviderError,
  classifyRedisCreateFailureKind,
} = shared;

function redact(text) {
  return String(text || '')
    .replace(/([?&](?:Password|password)=)[^&"'\s]*/g, '$1***')
    .slice(0, 1500);
}

const prisma = new PrismaClient();
try {
  const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
  if (!cr) {
    console.error(JSON.stringify({ error: 'not found', CR }));
    process.exit(1);
  }
  const meta = cr.metadata && typeof cr.metadata === 'object' ? { ...cr.metadata } : {};
  const region = cr.region || meta.region || 'cn-hangzhou';
  const instanceName = String(meta.instanceName || '').trim();

  const account = await prisma.providerAccount.findFirst({
    where: { status: 'ACTIVE', provider: { type: 'ALIYUN' }, workspaceId: cr.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const provider = new AlibabaCloudRedisProvider({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region,
  });

  const ids = instanceName ? await provider.listInstancesByName(region, instanceName) : [];
  const tech = redact(meta.technicalMessage || '');
  const reparsed = parseAliyunRedisProviderError(new Error(tech));
  const failureKind = classifyRedisCreateFailureKind({
    errorCode: meta.errorCode,
    providerErrorCode: reparsed.providerErrorCode || meta.providerErrorCode,
    technicalMessage: tech,
    httpStatus: reparsed.httpStatus ?? meta.httpStatus,
  });

  if (ids.length !== 1) {
    console.log(
      JSON.stringify(
        {
          cloudResourceId: CR,
          matchCount: ids.length,
          instanceIds: ids,
          verdict:
            ids.length === 0
              ? 'no_claim'
              : 'REDIS_RECONCILE_AMBIGUOUS',
          reparsedProviderErrorCode: reparsed.providerErrorCode,
          failureKind,
          applied: false,
        },
        null,
        2,
      ),
    );
    process.exit(ids.length > 1 ? 2 : 0);
  }

  const claimId = ids[0];
  const status = await provider.getInstanceStatus(claimId);
  const gens = Array.isArray(meta.createGenerations)
    ? meta.createGenerations.map((g) => ({ ...g }))
    : [];
  if (gens.length >= 2) {
    const last = gens[gens.length - 1];
    gens[gens.length - 1] = {
      ...last,
      attemptCount: Math.max(Number(last.attemptCount || 0), 1),
      successCount: Math.max(Number(last.successCount || 0), 1),
      terminalErrorCode: null,
      lastRequestId: meta.providerRequestId || last.lastRequestId || null,
    };
  }

  const nextMeta = {
    ...meta,
    providerResourceId: claimId,
    createInstanceCompleted: true,
    reconciledFromProvider: true,
    recoveredAfterTimeout: true,
    claimedAt: new Date().toISOString(),
    claimedInstanceId: claimId,
    // Correct mis-parsed EngineVersion from URL query.
    providerErrorCode: reparsed.providerErrorCode || 'ConnectTimeout',
    providerErrorMessage: tech,
    technicalMessage: tech,
    errorCode: 'PROVIDER_TIMEOUT',
    errorMessage: '连接阿里云 Redis 服务超时，请稍后重试。（实例已通过 reconcile 认领）',
    createFailureKind: failureKind,
    failedOperation: 'CreateInstance',
    failedAt: meta.failedAt || cr.updatedAt?.toISOString?.() || new Date().toISOString(),
    createInstanceAttemptCount: Number(meta.createInstanceAttemptCount || 8),
    createInstanceSuccessCount: Math.max(Number(meta.createInstanceSuccessCount || 0), 1),
    generationAttemptCount: Math.max(Number(meta.generationAttemptCount || 0), 1),
    generationSuccessCount: Math.max(Number(meta.generationSuccessCount || 0), 1),
    createGenerations: gens.length ? gens : meta.createGenerations,
    // Do NOT advance to generation 3.
  };

  if (APPLY) {
    await prisma.cloudResource.update({
      where: { id: CR },
      data: {
        providerResourceId: claimId,
        externalId: claimId,
        // Keep FAILED until user resumes network/auth steps — or set CREATING?
        // User said claim and stop — keep status, just bind id so resume skips Create.
        metadata: nextMeta,
      },
    });
  }

  console.log(
    JSON.stringify(
      {
        cloudResourceId: CR,
        matchCount: 1,
        instanceIds: [claimId],
        instanceStatus: status,
        verdict: 'claimed',
        applied: APPLY,
        providerResourceId: claimId,
        reparsed: {
          providerErrorCode: reparsed.providerErrorCode,
          providerRequestId: reparsed.providerRequestId,
          httpStatus: reparsed.httpStatus,
          failureKind,
        },
        counters: {
          createInstanceAttemptCount: nextMeta.createInstanceAttemptCount,
          createInstanceSuccessCount: nextMeta.createInstanceSuccessCount,
          generationAttemptCount: nextMeta.generationAttemptCount,
          generationSuccessCount: nextMeta.generationSuccessCount,
          createGeneration: nextMeta.createGeneration || meta.createGeneration,
        },
        note: 'No CreateInstance. No generation 3. Resume later to finish network/auth/bind.',
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
