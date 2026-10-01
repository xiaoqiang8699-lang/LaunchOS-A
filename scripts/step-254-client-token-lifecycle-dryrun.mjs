/**
 * Step 25.4 ClientToken lifecycle: prepare generation 2 + dry-run preview.
 * Does NOT call CreateInstance. Does NOT enqueue. Does NOT --confirm-billing.
 *
 *   node scripts/step-254-client-token-lifecycle-dryrun.mjs [cloudResourceId]
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
const providers = require(resolve(root, 'packages/providers/dist/index.js'));
const {
  decryptCredential,
  advanceRedisCreateGeneration,
  classifyRedisCreateFailureKind,
  shouldRotateRedisCreateClientToken,
} = shared;
const { AlibabaCloudRedisProvider, buildCreateInstanceRequestPreview } = providers;

function redactOp(op) {
  if (!op || typeof op !== 'string') return null;
  if (op.length <= 10) return `${op.slice(0, 4)}…`;
  return `${op.slice(0, 6)}…${op.slice(-4)}`;
}

const prisma = new PrismaClient();

try {
  const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
  if (!cr) {
    console.error(JSON.stringify({ error: 'CloudResource not found', cloudResourceId: CR }));
    process.exit(1);
  }

  const meta = cr.metadata && typeof cr.metadata === 'object' ? { ...cr.metadata } : {};
  const sku = meta.resolvedSku || {};
  const region = cr.region || meta.region || 'cn-hangzhou';
  const instanceName = String(meta.instanceName || '').trim();
  const oldOperationId = String(meta.operationId || '').trim() || null;

  const account = await prisma.providerAccount.findFirst({
    where: { status: 'ACTIVE', provider: { type: 'ALIYUN' }, workspaceId: cr.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  if (!account) {
    console.error(JSON.stringify({ error: 'No ACTIVE ALIYUN provider account' }));
    process.exit(1);
  }
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const provider = new AlibabaCloudRedisProvider({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region,
  });

  const reconcileIds = instanceName
    ? await provider.listInstancesByName(region, instanceName)
    : [];
  const reconcileMatchCount = reconcileIds.length;

  const failureKind =
    meta.createFailureKind ||
    classifyRedisCreateFailureKind({
      errorCode: meta.errorCode,
      providerErrorCode: meta.providerErrorCode,
      technicalMessage: meta.technicalMessage,
      httpStatus: meta.httpStatus,
    });

  const rotateDecision = shouldRotateRedisCreateClientToken({
    providerResourceId: cr.providerResourceId,
    createInstanceCompleted: meta.createInstanceCompleted === true,
    reconcileMatchCount,
    failureKind,
    userRequestedRetry: true,
  });

  const existingGens = Array.isArray(meta.createGenerations) ? meta.createGenerations : [];
  const alreadyPrepared =
    Number(meta.createGeneration || 1) >= 2 &&
    existingGens.length >= 2 &&
    Boolean(existingGens[0]?.closedAt) &&
    !existingGens[existingGens.length - 1]?.closedAt;

  let advanced = null;
  let applied = false;
  let nextMeta = { ...meta };

  if (reconcileMatchCount > 1) {
    console.log(
      JSON.stringify(
        {
          cloudResourceId: CR,
          verdict: 'REDIS_RECONCILE_AMBIGUOUS',
          reconcileCount: reconcileMatchCount,
          instanceIds: reconcileIds,
          dryRunCreate: false,
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  if (reconcileMatchCount === 1) {
    console.log(
      JSON.stringify(
        {
          cloudResourceId: CR,
          verdict: 'reconcile_claim',
          reconcileCount: 1,
          claimInstanceId: reconcileIds[0],
          note: 'Do not rotate ClientToken; claim existing instance.',
          dryRunCreate: false,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (rotateDecision.rotate && !alreadyPrepared) {
    advanced = advanceRedisCreateGeneration({
      generations: existingGens,
      currentOperationId: oldOperationId,
      closedAttemptCount: Number(
        meta.generationAttemptCount ?? meta.createInstanceAttemptCount ?? 0,
      ),
      closedSuccessCount: Number(
        meta.generationSuccessCount ?? meta.createInstanceSuccessCount ?? 0,
      ),
      totalAttemptCount: Number(meta.createInstanceAttemptCount || 0),
      totalSuccessCount: Number(meta.createInstanceSuccessCount || 0),
      terminalErrorCode: meta.providerErrorCode || meta.errorCode || null,
      lastRequestId: meta.providerRequestId || null,
    });
    nextMeta = {
      ...meta,
      operationId: advanced.operationId,
      createGeneration: advanced.createGeneration,
      createGenerations: advanced.createGenerations,
      previousOperationId: advanced.previousOperationId,
      generationAttemptCount: 0,
      generationSuccessCount: 0,
      clientTokenRotateReason: rotateDecision.reason,
      createFailureKind: null,
      // Preserve totals; do not reset.
      createInstanceAttemptCount: Number(meta.createInstanceAttemptCount || 0),
      createInstanceSuccessCount: Number(meta.createInstanceSuccessCount || 0),
      // Keep SKU fields unchanged.
      instanceClass: meta.instanceClass || sku.instanceClass,
      engineVersion: meta.engineVersion || sku.engineVersion,
      storageType: meta.storageType || sku.storageType,
      capacityMb: meta.capacityMb ?? sku.capacityMb,
      zoneId: meta.zoneId || sku.zoneId,
      architecture: meta.architecture || sku.architecture,
      resolvedSku: meta.resolvedSku || sku,
      preparedGeneration2At: new Date().toISOString(),
      preparedGeneration2Mode: 'dry-run-no-create',
    };

    if (APPLY) {
      await prisma.cloudResource.update({
        where: { id: CR },
        data: { metadata: nextMeta },
      });
      applied = true;
    }
  } else if (alreadyPrepared) {
    advanced = {
      createGeneration: Number(meta.createGeneration),
      operationId: String(meta.operationId),
      createGenerations: existingGens,
      previousOperationId: meta.previousOperationId || existingGens[0]?.operationId || null,
    };
    nextMeta = meta;
  }

  const effectiveOp = String(nextMeta.operationId || oldOperationId || '');
  const preview = buildCreateInstanceRequestPreview({
    region,
    zoneId: nextMeta.zoneId || sku.zoneId || nextMeta.placementZoneId,
    instanceClass: nextMeta.instanceClass || sku.instanceClass,
    engineVersion: nextMeta.engineVersion || sku.engineVersion,
    storageType: nextMeta.storageType || sku.storageType,
    architecture: nextMeta.architecture || sku.architecture,
    capacityMb: nextMeta.capacityMb ?? sku.capacityMb,
    vpcId: nextMeta.vpcId,
  });

  const requestPreview = {
    regionId: preview.regionId,
    zoneId: preview.zoneId,
    instanceClass: preview.instanceClass,
    engineVersion: preview.engineVersion,
    instanceType: preview.instanceType,
    chargeType: preview.chargeType,
    networkType: preview.networkType,
    nodeType: preview.nodeType,
    capacity: preview.capacity,
    vpcId: nextMeta.vpcId || null,
    vSwitchId: nextMeta.vSwitchId || null,
    instanceName: nextMeta.instanceName || null,
    clientToken: effectiveOp.slice(0, 64) || null,
    // Informational only — not sent as Capacity override beyond preview.capacity
  };

  const previousSkuFingerprint = {
    instanceClass: 'redis.master.small.default',
    engineVersion: '5.0',
    storageType: 'Local',
    zoneId: 'cn-hangzhou-i',
    capacity: 1024,
  };
  const skuMatch =
    requestPreview.instanceClass === previousSkuFingerprint.instanceClass &&
    requestPreview.engineVersion === previousSkuFingerprint.engineVersion &&
    String(preview.storageType || nextMeta.storageType || sku.storageType) ===
      previousSkuFingerprint.storageType &&
    requestPreview.zoneId === previousSkuFingerprint.zoneId &&
    Number(requestPreview.capacity) === previousSkuFingerprint.capacity;

  console.log(
    JSON.stringify(
      {
        cloudResourceId: CR,
        dryRunCreate: false,
        confirmBilling: false,
        applied,
        applyHint: APPLY
          ? 'metadata updated in-place (same CloudResource)'
          : 'pass --apply to persist generation 2 on this CloudResource',
        currentGeneration: advanced?.createGeneration ?? Number(meta.createGeneration || 1),
        previousOperationId: redactOp(
          advanced?.previousOperationId || meta.previousOperationId || oldOperationId,
        ),
        previousOperationIdFull_auditOnly: advanced?.previousOperationId || oldOperationId,
        currentOperationId: advanced?.operationId || effectiveOp,
        currentOperationIdRedacted: redactOp(advanced?.operationId || effectiveOp),
        operationIdChanged: Boolean(
          advanced &&
            advanced.previousOperationId &&
            advanced.operationId !== advanced.previousOperationId,
        ),
        rotateDecision,
        failureKind,
        reconcileCount: reconcileMatchCount,
        providerResourceId: cr.providerResourceId ?? null,
        createGenerations: (advanced?.createGenerations || existingGens).map((g) => ({
          generation: g.generation,
          operationId: redactOp(g.operationId),
          attemptCount: g.attemptCount,
          successCount: g.successCount,
          terminalErrorCode: g.terminalErrorCode || null,
          lastRequestId: g.lastRequestId || null,
          createdAt: g.createdAt || null,
          closedAt: g.closedAt || null,
        })),
        counters: {
          createInstanceAttemptCount: Number(
            nextMeta.createInstanceAttemptCount ?? meta.createInstanceAttemptCount ?? 0,
          ),
          createInstanceSuccessCount: Number(
            nextMeta.createInstanceSuccessCount ?? meta.createInstanceSuccessCount ?? 0,
          ),
          generationAttemptCount: Number(nextMeta.generationAttemptCount ?? 0),
          generationSuccessCount: Number(nextMeta.generationSuccessCount ?? 0),
        },
        currentResolvedSku: {
          instanceClass: requestPreview.instanceClass,
          engineVersion: requestPreview.engineVersion,
          storageType: preview.storageType || nextMeta.storageType || sku.storageType,
          zoneId: requestPreview.zoneId,
          capacity: requestPreview.capacity,
        },
        skuUnchangedExceptToken: skuMatch,
        createInstanceRequestPreview: requestPreview,
        note: 'ClientToken is the only intended change vs prior Create attempts.',
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
