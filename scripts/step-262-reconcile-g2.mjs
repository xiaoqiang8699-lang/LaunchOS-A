/**
 * Step 26.2 — generation-2 only reconcile (read DescribeInstances; adopt if exactly 1).
 *
 * Does NOT:
 *   --confirm-billing / RunInstances / new CloudResource / generation rotate / g3 enqueue
 *
 *   node scripts/step-262-reconcile-g2.mjs
 *   node scripts/step-262-reconcile-g2.mjs --cloud-resource-id=cmuas8iiz0001riown1l1a0o3
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStep262Argv } from './lib/step-262-cli.mjs';

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

const { cloudResourceId: CLI_CR } = parseStep262Argv(process.argv);
const CR_ID = CLI_CR || 'cmuas8iiz0001riown1l1a0o3';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const WORKSPACE_ID = 'cmu13yafy0002ridotzb6it78';
const INSTANCE_NAME = 'launchos-launchos';

const require = createRequire(resolve(root, 'packages/providers/package.json'));
const { PrismaClient } = createRequire(resolve(root, 'apps/api/package.json'))('@launchos/database');
const {
  decryptCredential,
  buildLaunchosEcsTags,
  classifyServerCreateFailureKind,
  shouldRotateServerCreateClientToken,
} = createRequire(resolve(root, 'packages/shared/package.json'))('@launchos/shared');
const ecsPkg = require('@alicloud/ecs20140526');
const openapi = require('@alicloud/openapi-core');

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
let runInstancesThisRound = 0;

try {
  const resource = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  if (!resource) {
    console.error(JSON.stringify({ error: 'CloudResource not found', CR_ID }));
    process.exitCode = 1;
    throw new Error('not found');
  }

  const meta =
    resource.metadata && typeof resource.metadata === 'object' && !Array.isArray(resource.metadata)
      ? { ...resource.metadata }
      : {};
  const createGeneration = Math.max(1, Number(meta.createGeneration || 1));
  if (createGeneration !== 2) {
    console.error(
      JSON.stringify({
        error: 'expected createGeneration=2',
        createGeneration,
        note: 'refusing to reconcile other generations this round',
      }),
    );
    process.exitCode = 1;
    throw new Error('wrong generation');
  }

  const operationId = String(meta.operationId || '');
  const clientToken = String(meta.clientToken || operationId).slice(0, 64);
  const instanceName = String(meta.instanceName || INSTANCE_NAME);
  const regionId = resource.region || 'cn-hangzhou';
  const projectId = resource.projectId || PROJECT_ID;
  const workspaceId = resource.workspaceId || WORKSPACE_ID;
  const expectedTags = buildLaunchosEcsTags({
    cloudResourceId: CR_ID,
    projectId,
    workspaceId,
  });

  const gens = Array.isArray(meta.createGenerations) ? meta.createGenerations : [];
  const g2 = gens.find((g) => Number(g?.generation) === 2) || null;
  const g2CreatedAt = g2?.createdAt ? new Date(g2.createdAt) : new Date(resource.updatedAt);
  // Reasonable window: from g2 open (minus 1h) through failedAt/now (+2h).
  const failedAt = meta.failedAt ? new Date(meta.failedAt) : new Date();
  const windowStart = new Date(g2CreatedAt.getTime() - 60 * 60_000);
  const windowEnd = new Date(Math.max(failedAt.getTime(), Date.now()) + 2 * 60 * 60_000);

  const account = await prisma.providerAccount.findFirst({
    where: {
      status: 'ACTIVE',
      workspaceId,
      provider: { type: 'ALIYUN' },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!account?.credentialEncrypted) {
    throw new Error('ALIYUN provider account missing');
  }
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const config = new openapi.$OpenApiUtil.Config({
    accessKeyId: secrets.accessKey,
    accessKeySecret: secrets.secretKey,
  });
  config.endpoint = `ecs.${regionId}.aliyuncs.com`;
  const ecs = new ecsPkg.default(config);

  // Query A: by ownership tag launchos:cloudResourceId
  const byCrTag = await describeBy(ecs, regionId, {
    tag: [{ key: 'launchos:cloudResourceId', value: CR_ID }],
  });
  // Query B: by instanceName (g2 saved name)
  const byName = await describeBy(ecs, regionId, { instanceName });
  // Query C: by project tag (broad, then filter)
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
      raw: inst,
    })),
  );

  const matched = candidates.filter((row) => {
    const tags = row.tags;
    const nameOk = row.instanceName === instanceName;
    const crOk = tags['launchos:cloudResourceId'] === CR_ID;
    const projectOk = tags['launchos:projectId'] === projectId;
    const workspaceOk = tags['launchos:workspaceId'] === workspaceId;
    const managedOk = tags['launchos:managed'] === 'true';
    // Prefer exact ownership tags; name alone is insufficient unless CR tag matches.
    const tagOk = crOk && projectOk && workspaceOk && managedOk;
    const timeOk = inWindow(row.createdAt, windowStart, windowEnd);
    return nameOk && tagOk && timeOk;
  });

  const matchCount = matched.length;
  const matchedInstanceIds = matched.map((m) => m.instanceId);
  const matchedStatuses = matched.map((m) => m.status);
  const matchedCreatedAt = matched.map((m) => m.createdAt);
  const publicIps = matched.map((m) => m.publicIp);
  const privateIps = matched.map((m) => m.privateIp);

  let verdict = 'NO_MATCH';
  let safeRotateToGeneration3 = false;
  let adopted = false;
  let ambiguous = false;

  const failureKind = classifyServerCreateFailureKind({
    errorCode: String(meta.lastErrorCode || ''),
    providerErrorCode: String(meta.providerErrorCode || ''),
    technicalMessage: String(meta.lastErrorMessage || ''),
  });
  const rotateHint = shouldRotateServerCreateClientToken({
    providerResourceId: resource.providerResourceId,
    createInstanceCompleted: meta.runInstancesCompleted === true,
    reconcileMatchCount: matchCount,
    failureKind,
    userRequestedRetry: true,
    runInstancesAttemptCount: Number(meta.runInstancesAttemptCount || 0),
  });

  const totalRunInstancesAttemptCount = Number(meta.runInstancesAttemptCount || 0);
  const generation2RunInstancesAttemptCount = totalRunInstancesAttemptCount;
  const generation2RunInstancesSuccessCount = Number(meta.runInstancesSuccessCount || 0);

  let providerResourceId = resource.providerResourceId;
  let createGenerationAfter = createGeneration;

  if (matchCount === 0) {
    verdict = 'NO_INSTANCE_TERMINAL_REJECTION_SAFE';
    safeRotateToGeneration3 = rotateHint.rotate === true || failureKind === 'TERMINAL_REJECTION';
    // Do NOT advance generation / create g3 this round.
    await prisma.cloudResource.update({
      where: { id: CR_ID },
      data: {
        metadata: {
          ...meta,
          reconcileG2: {
            at: new Date().toISOString(),
            matchCount: 0,
            matchedInstanceIds: [],
            safeRotateToGeneration3,
            rotateHintReason: rotateHint.reason,
            failureKind,
            clientToken,
            operationId,
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
            note: 'g2 reconcile: no ECS; generation stays 2 until user reconfirms create',
          },
        },
      },
    });
  } else if (matchCount === 1) {
    verdict = 'ADOPT';
    safeRotateToGeneration3 = false;
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
          createGeneration: 2,
          runInstancesCompleted: true,
          reconciledFromProvider: true,
          phase: 'WAITING_INSTANCE',
          reconcileG2: {
            at: new Date().toISOString(),
            matchCount: 1,
            matchedInstanceIds: [hit.instanceId],
            adopted: true,
            safeRotateToGeneration3: false,
            clientToken,
            operationId,
            publicIp: hit.publicIp,
            privateIp: hit.privateIp,
            status: hit.status,
            note: 'g2 reconcile adopt — no RunInstances / no g3',
          },
        },
      },
    });
    adopted = true;
  } else {
    verdict = 'AMBIGUOUS';
    ambiguous = true;
    safeRotateToGeneration3 = false;
    await prisma.cloudResource.update({
      where: { id: CR_ID },
      data: {
        status: 'FAILED',
        metadata: {
          ...meta,
          createGeneration: 2,
          phase: 'FAILED',
          failedOperation: 'DescribeInstances',
          lastErrorCode: 'ECS_RECONCILE_AMBIGUOUS',
          providerErrorCode: 'ECS_RECONCILE_AMBIGUOUS',
          lastErrorUserMessage:
            '检测到多台同名云服务器，已停止自动创建，请人工确认。',
          reconcileG2: {
            at: new Date().toISOString(),
            matchCount,
            matchedInstanceIds,
            ambiguous: true,
            safeRotateToGeneration3: false,
            note: 'AMBIGUOUS — stop auto create; generation stays 2',
          },
        },
      },
    });
  }

  const after = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  const afterMeta = after?.metadata || {};
  createGenerationAfter = Number(afterMeta.createGeneration || createGeneration);

  console.log(
    JSON.stringify(
      {
        ok: true,
        cloudResourceId: CR_ID,
        createGeneration: createGenerationAfter,
        operationId,
        clientToken,
        instanceName,
        expectedTags,
        window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
        queries: {
          byCrTag: byCrTag.length,
          byName: byName.length,
          byProject: byProject.length,
          candidates: candidates.length,
        },
        matchCount,
        matchedInstanceIds,
        matchedStatuses,
        matchedCreatedAt,
        publicIp: publicIps,
        privateIp: privateIps,
        verdict,
        adopted,
        ambiguous,
        safeRotateToGeneration3,
        g3Generated: false,
        generationRotated: createGenerationAfter !== 2 ? true : false,
        providerResourceId: after?.providerResourceId ?? providerResourceId,
        counters: {
          totalRunInstancesAttemptCount,
          generation2RunInstancesAttemptCount,
          generation2RunInstancesSuccessCount,
          createGenerationsG2AttemptCount: Number(g2?.attemptCount || 0),
        },
        RUN_INSTANCES_CALLED: runInstancesThisRound,
        failureKind,
        rotateHint,
      },
      null,
      2,
    ),
  );

  if (createGenerationAfter !== 2) process.exitCode = 1;
  if (runInstancesThisRound !== 0) process.exitCode = 1;
} catch (error) {
  if (!process.exitCode) process.exitCode = 1;
  console.error(String(error?.stack || error?.message || error));
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
