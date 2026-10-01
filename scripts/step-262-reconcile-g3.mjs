/**
 * Step 26.2 — generation-3 only reconcile after NotEnoughBalance (no RunInstances).
 *
 *   node scripts/step-262-reconcile-g3.mjs
 */
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

const CR_ID = 'cmuas8iiz0001riown1l1a0o3';
const requireProviders = createRequire(resolve(root, 'packages/providers/package.json'));
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireShared = createRequire(resolve(root, 'packages/shared/package.json'));

const { PrismaClient } = requireApi('@launchos/database');
const {
  buildLaunchosEcsTags,
  classifyCloudEcsError,
  classifyServerCreateFailureKind,
  cloudEcsErrorUserMessage,
  decryptCredential,
  isServerProvisionTerminalNoAutoRetry,
  shouldRotateServerCreateClientToken,
} = requireShared('@launchos/shared');
const ecsPkg = requireProviders('@alicloud/ecs20140526');
const openapi = requireProviders('@alicloud/openapi-core');

function tagMap(instance) {
  const out = {};
  for (const t of instance.tags?.tag || []) {
    if (t.tagKey) out[t.tagKey] = String(t.tagValue ?? '');
  }
  return out;
}
function publicIpOf(instance) {
  return (
    instance.publicIpAddress?.ipAddress?.[0]?.trim() ||
    instance.eipAddress?.ipAddress?.trim() ||
    null
  );
}
function privateIpOf(instance) {
  return instance.vpcAttributes?.privateIpAddress?.ipAddress?.[0] || null;
}
function inWindow(createdAtIso, windowStart, windowEnd) {
  if (!createdAtIso) return true;
  const t = Date.parse(createdAtIso);
  if (Number.isNaN(t)) return true;
  return t >= windowStart.getTime() && t <= windowEnd.getTime();
}
function dedupeById(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.instanceId) continue;
    map.set(row.instanceId, row);
  }
  return [...map.values()];
}
async function describeBy(ecs, regionId, request) {
  const resp = await ecs.describeInstances(
    new ecsPkg.DescribeInstancesRequest({
      regionId,
      pageSize: 50,
      pageNumber: 1,
      ...request,
    }),
  );
  return resp.body?.instances?.instance || [];
}

const prisma = new PrismaClient();
const RUN_INSTANCES_CALLED = 0;

try {
  const resource = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  if (!resource) throw new Error('not found');
  const meta =
    resource.metadata && typeof resource.metadata === 'object' && !Array.isArray(resource.metadata)
      ? { ...resource.metadata }
      : {};
  const createGeneration = Math.max(1, Number(meta.createGeneration || 1));
  if (createGeneration !== 3) {
    throw new Error(`expected createGeneration=3, got ${createGeneration}`);
  }

  const operationId = String(meta.operationId || '');
  const clientToken = String(meta.clientToken || operationId).slice(0, 64);
  const instanceName = String(meta.instanceName || 'launchos-launchos');
  const regionId = resource.region || 'cn-hangzhou';
  const projectId = resource.projectId;
  const workspaceId = resource.workspaceId;
  const expectedTags = buildLaunchosEcsTags({
    cloudResourceId: CR_ID,
    projectId,
    workspaceId,
  });

  const gens = Array.isArray(meta.createGenerations) ? [...meta.createGenerations] : [];
  const g2 = gens.find((g) => Number(g?.generation) === 2) || null;
  const g3 = gens.find((g) => Number(g?.generation) === 3) || null;
  const g3CreatedAt = g3?.createdAt ? new Date(g3.createdAt) : new Date(resource.updatedAt);
  const failedAt = meta.failedAt ? new Date(meta.failedAt) : new Date();
  const windowStart = new Date(g3CreatedAt.getTime() - 60 * 60_000);
  const windowEnd = new Date(Math.max(failedAt.getTime(), Date.now()) + 2 * 60 * 60_000);

  const totalRunInstancesAttemptCount = Number(meta.runInstancesAttemptCount || 0);
  const generation2RunInstancesAttemptCount = Number(g2?.attemptCount || 0);
  const generation3RunInstancesAttemptCount = Number(g3?.attemptCount || 0);
  const generation3RunInstancesSuccessCount = Number(
    g3?.successCount ?? meta.runInstancesSuccessCount ?? 0,
  );

  // Bug marker: g3 should have been attempt=1; BullMQ attempts:2 caused double call.
  const g3AutoRetryBug =
    generation3RunInstancesAttemptCount > 1
      ? {
          bug: true,
          reason: 'BullMQ server-provision enqueue used attempts:2 with exponential backoff',
          evidence: {
            expectedMaxPerGeneration: 1,
            observedG3Attempt: generation3RunInstancesAttemptCount,
            totalAttempt: totalRunInstancesAttemptCount,
            formula: 'total≈g2(1)+g3(2)=3',
          },
          fixApplied: 'queue attempts:1 + UnrecoverableError on TERMINAL_REJECTION + same-gen guard',
        }
      : { bug: false };

  const account = await prisma.providerAccount.findFirst({
    where: { status: 'ACTIVE', workspaceId, provider: { type: 'ALIYUN' } },
    orderBy: { createdAt: 'asc' },
  });
  if (!account?.credentialEncrypted) throw new Error('ALIYUN account missing');
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const config = new openapi.$OpenApiUtil.Config({
    accessKeyId: secrets.accessKey,
    accessKeySecret: secrets.secretKey,
  });
  config.endpoint = `ecs.${regionId}.aliyuncs.com`;
  const ecs = new ecsPkg.default(config);

  const byCrTag = await describeBy(ecs, regionId, {
    tag: [{ key: 'launchos:cloudResourceId', value: CR_ID }],
  });
  const byName = await describeBy(ecs, regionId, { instanceName });
  const byProject = await describeBy(ecs, regionId, {
    tag: [{ key: 'launchos:projectId', value: projectId }],
  });

  const candidates = dedupeById(
    [...byCrTag, ...byName, ...byProject].map((inst) => ({
      instanceId: inst.instanceId,
      status: inst.status || null,
      createdAt: inst.creationTime || null,
      publicIp: publicIpOf(inst),
      privateIp: privateIpOf(inst),
      instanceName: inst.instanceName || null,
      tags: tagMap(inst),
    })),
  );

  const matched = candidates.filter((row) => {
    const tags = row.tags;
    return (
      row.instanceName === instanceName &&
      tags['launchos:cloudResourceId'] === CR_ID &&
      tags['launchos:projectId'] === projectId &&
      tags['launchos:workspaceId'] === workspaceId &&
      tags['launchos:managed'] === 'true' &&
      inWindow(row.createdAt, windowStart, windowEnd)
    );
  });

  const matchCount = matched.length;
  const failureKind = classifyServerCreateFailureKind({
    errorCode: classifyCloudEcsError({
      message: String(meta.lastErrorMessage || meta.providerErrorCode || ''),
      code: meta.providerErrorCode,
    }),
    providerErrorCode: String(meta.providerErrorCode || ''),
    technicalMessage: String(meta.lastErrorMessage || ''),
    httpStatus: Number(meta.httpStatus || 0) || null,
  });
  const ecsCode = classifyCloudEcsError({
    message: String(meta.lastErrorMessage || ''),
    code: meta.providerErrorCode,
  });
  const rotateHint = shouldRotateServerCreateClientToken({
    providerResourceId: resource.providerResourceId,
    createInstanceCompleted: meta.runInstancesCompleted === true,
    reconcileMatchCount: matchCount,
    failureKind,
    userRequestedRetry: true,
    runInstancesAttemptCount: totalRunInstancesAttemptCount,
  });

  let safeRotateToGeneration4 = false;
  let verdict = 'NO_MATCH';
  let providerResourceId = resource.providerResourceId;

  if (matchCount === 0) {
    verdict = 'NO_INSTANCE_TERMINAL_SAFE';
    safeRotateToGeneration4 =
      rotateHint.rotate === true || failureKind === 'TERMINAL_REJECTION';
    // Do NOT rotate to g4 this round.
  } else if (matchCount === 1) {
    verdict = 'ADOPT';
    safeRotateToGeneration4 = false;
    const hit = matched[0];
    providerResourceId = hit.instanceId;
    await prisma.cloudResource.update({
      where: { id: CR_ID },
      data: {
        providerResourceId: hit.instanceId,
        externalId: hit.instanceId,
        publicIp: hit.publicIp || null,
        status: 'CREATING',
        metadata: {
          ...meta,
          createGeneration: 3,
          runInstancesCompleted: true,
          reconciledFromProvider: true,
          phase: 'WAITING_INSTANCE',
          reconcileG3: {
            at: new Date().toISOString(),
            matchCount: 1,
            matchedInstanceIds: [hit.instanceId],
            adopted: true,
            safeRotateToGeneration4: false,
          },
        },
      },
    });
  } else {
    verdict = 'AMBIGUOUS';
    safeRotateToGeneration4 = false;
  }

  // Correct classification on CR (even when matchCount=0) — no RunInstances.
  const correctedCode =
    ecsCode === 'UNKNOWN' && /notenoug|insufficient/i.test(String(meta.providerErrorCode || ''))
      ? 'BILLING_NOT_ENOUGH_BALANCE'
      : ecsCode === 'UNKNOWN'
        ? classifyCloudEcsError({
            code: meta.providerErrorCode,
            message: String(meta.lastErrorMessage || meta.providerErrorCode || ''),
          })
        : ecsCode;

  if (matchCount !== 1) {
    const nextGens = gens.map((g) => {
      if (Number(g.generation) !== 3) return g;
      return {
        ...g,
        // Preserve observed buggy attempt=2 history; annotate.
        attemptCount: Number(g.attemptCount || 0),
        successCount: Number(g.successCount || 0),
        lastRequestId: meta.lastRequestId || g.lastRequestId || null,
        terminalErrorCode: 'InvalidAccountStatus.NotEnoughBalance',
        autoRetryBug: g3AutoRetryBug.bug === true,
        autoRetryBugNote: g3AutoRetryBug.bug
          ? 'g3 RunInstances auto-retried via BullMQ attempts:2; history retained'
          : undefined,
      };
    });

    await prisma.cloudResource.update({
      where: { id: CR_ID },
      data: {
        status: matchCount > 1 ? 'FAILED' : 'FAILED',
        providerResourceId: matchCount === 0 ? null : providerResourceId,
        metadata: {
          ...meta,
          createGeneration: 3,
          createGenerations: nextGens,
          lastErrorCode: correctedCode,
          errorCategory: 'BILLING_NOT_ENOUGH_BALANCE',
          lastErrorUserMessage: cloudEcsErrorUserMessage(
            correctedCode === 'UNKNOWN' ? 'BILLING_NOT_ENOUGH_BALANCE' : correctedCode,
            'RunInstances',
          ),
          failedOperation: 'RunInstances',
          providerErrorCode: meta.providerErrorCode || 'InvalidAccountStatus.NotEnoughBalance',
          lastRequestId: meta.lastRequestId || '01A0C3C9-2D92-5A13-9745-97C88B43EEF7',
          httpStatus: meta.httpStatus || 403,
          createFailureKind: 'TERMINAL_REJECTION',
          billingAccountBalance: 'INSUFFICIENT',
          requiresUserAction: true,
          autoRetryBlocked: true,
          reconcileG3: {
            at: new Date().toISOString(),
            matchCount,
            matchedInstanceIds: matched.map((m) => m.instanceId),
            safeRotateToGeneration4,
            rotateHintReason: rotateHint.reason,
            failureKind,
            clientToken,
            operationId,
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
            note:
              matchCount === 0
                ? 'g3 reconcile: no ECS; generation stays 3 until user tops up balance and --confirm-billing (then g4)'
                : 'AMBIGUOUS — stop auto create',
            g3AutoRetryBug,
          },
        },
      },
    });
  }

  const after = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  const am = after?.metadata || {};

  console.log(
    JSON.stringify(
      {
        ok: true,
        createGeneration: Number(am.createGeneration),
        matchCount,
        matchedInstanceIds: matched.map((m) => m.instanceId),
        matchedStatuses: matched.map((m) => m.status),
        publicIp: matched.map((m) => m.publicIp),
        privateIp: matched.map((m) => m.privateIp),
        verdict,
        safeRotateToGeneration4,
        g4Generated: false,
        providerResourceId: after?.providerResourceId ?? null,
        counters: {
          totalRunInstancesAttemptCount,
          generation2RunInstancesAttemptCount,
          generation3RunInstancesAttemptCount,
          generation3RunInstancesSuccessCount,
        },
        classification: {
          lastErrorCode: am.lastErrorCode,
          errorCategory: am.errorCategory,
          createFailureKind: am.createFailureKind,
          billingAccountBalance: am.billingAccountBalance,
          providerErrorCode: am.providerErrorCode,
          providerRequestId: am.lastRequestId,
          httpStatus: am.httpStatus,
          failedOperation: am.failedOperation,
          userMessage: am.lastErrorUserMessage,
          noAutoRetry: isServerProvisionTerminalNoAutoRetry({
            errorCode: am.lastErrorCode,
            providerErrorCode: am.providerErrorCode,
            technicalMessage: am.lastErrorMessage,
            failureKind: am.createFailureKind,
            httpStatus: am.httpStatus,
          }),
        },
        g3AutoRetryBug,
        expectedTags,
        RUN_INSTANCES_CALLED,
      },
      null,
      2,
    ),
  );
} catch (error) {
  process.exitCode = 1;
  console.error(String(error?.stack || error?.message || error));
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
