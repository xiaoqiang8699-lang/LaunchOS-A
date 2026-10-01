/**
 * Non-billing fixture: production handler path through CREATING_INSTANCE,
 * then abort before real SDK RunInstances via explicit testOnly DI hooks.
 *
 * Forbidden: metadata fixture flags, --confirm-billing, real RunInstances.
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

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const { assessServerProvisionStaleRecovery } = require('@launchos/shared');
const { executeServerProvision } = require(resolve(
  root,
  'apps/worker/dist/server-provision-executor.js',
));

const CR_ID = 'cmuas8iiz0001riown1l1a0o3';
const prisma = new PrismaClient();

let sdkRunInstancesCalled = false;
const mockProvisioner = {
  async reconcileManagedInstances() {
    return [];
  },
  async ensureNetwork() {
    return {
      vpcId: 'vpc-fixture',
      vSwitchId: 'vsw-fixture',
      zoneId: 'cn-hangzhou-i',
    };
  },
  async ensureSecurityGroup() {
    return 'sg-fixture';
  },
  async assertImageAvailable() {
    return;
  },
  async runInstance() {
    sdkRunInstancesCalled = true;
    throw new Error('SDK RunInstances must not be called in this fixture');
  },
};

try {
  const before = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  if (!before) throw new Error('CR missing');
  const beforeMeta =
    before.metadata && typeof before.metadata === 'object' ? { ...before.metadata } : {};
  const gen = Math.max(1, Number(beforeMeta.createGeneration || 2));

  await prisma.cloudResource.update({
    where: { id: CR_ID },
    data: {
      status: 'CREATING',
      providerResourceId: null,
      metadata: {
        ...beforeMeta,
        createGeneration: gen,
        phase: 'QUEUED',
        runInstancesAttemptCount: 0,
        runInstancesSuccessCount: 0,
        fixtureStopBeforeRunInstances: null,
        fixtureStopReached: null,
        fixtureStopAt: null,
        fixtureNote: null,
        phases: [
          ...(Array.isArray(beforeMeta.phases) ? beforeMeta.phases : []),
          {
            phase: 'QUEUED',
            at: new Date().toISOString(),
            status: 'running',
            fixture: 'creating_instance_mock',
          },
        ],
      },
    },
  });

  let thrown = null;
  try {
    await executeServerProvision(prisma, CR_ID, {
      provisioner: mockProvisioner,
      abortBeforeSdkRunInstances: true,
    });
  } catch (error) {
    thrown = error;
  }

  const after = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  const m = after.metadata && typeof after.metadata === 'object' ? after.metadata : {};
  const phases = Array.isArray(m.phases) ? m.phases.map((p) => p.phase) : [];

  const report = {
    ok:
      phases.includes('RECONCILING') &&
      phases.includes('PREPARING_NETWORK') &&
      phases.includes('PREPARING_SECURITY_GROUP') &&
      phases.includes('CREATING_INSTANCE') &&
      Number(m.runInstancesAttemptCount || 0) === 1 &&
      sdkRunInstancesCalled === false &&
      !after.providerResourceId &&
      Number(m.createGeneration) === gen &&
      (thrown?.code === 'MOCK_ABORT_BEFORE_RUN_INSTANCES' ||
        String(thrown?.message || '').includes('MOCK_ABORT_BEFORE_RUN_INSTANCES')),
    phaseAfterHandler: m.phase,
    failedPhase: m.failedPhase,
    failedOperation: m.failedOperation,
    phasesReached: [...new Set(phases)],
    runInstancesAttemptCount: Number(m.runInstancesAttemptCount || 0),
    sdkRunInstancesCalled,
    providerResourceId: after.providerResourceId,
    createGeneration: m.createGeneration,
    thrownCode: thrown?.code || null,
    productionHandlerReachedCreatingInstance: phases.includes('CREATING_INSTANCE'),
    note: 'abortBeforeSdkRunInstances only via explicit function arg — never metadata/job/env',
  };
  console.log(JSON.stringify(report, null, 2));

  // Restore live CR for safe same-generation resume (attempt=0, no provider id).
  await prisma.cloudResource.update({
    where: { id: CR_ID },
    data: {
      status: 'CREATING',
      providerResourceId: null,
      metadata: {
        ...m,
        phase: 'PREPARING_SECURITY_GROUP',
        createGeneration: gen,
        runInstancesAttemptCount: 0,
        runInstancesSuccessCount: 0,
        failedPhase: null,
        failedOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorUserMessage: null,
        providerErrorCode: null,
        lastRequestId: null,
        httpStatus: null,
        failedAt: null,
        fixtureStopBeforeRunInstances: null,
        fixtureStopReached: null,
        fixtureStopAt: null,
        fixtureNote: null,
      },
    },
  });

  const live = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  const lm = live.metadata;
  const safe = assessServerProvisionStaleRecovery({
    status: live.status,
    phase: lm.phase,
    providerResourceId: live.providerResourceId,
    runInstancesAttemptCount: Number(lm.runInstancesAttemptCount || 0),
    queueJobState: 'completed',
    createGeneration: Number(lm.createGeneration || 2),
  });
  console.log(
    JSON.stringify(
      {
        liveCr: {
          status: live.status,
          phase: lm.phase,
          createGeneration: lm.createGeneration,
          runInstancesAttemptCount: lm.runInstancesAttemptCount || 0,
          providerResourceId: live.providerResourceId,
        },
        safeResume: safe,
      },
      null,
      2,
    ),
  );

  if (!report.ok) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
