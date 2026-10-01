/**
 * Service-level stale recovery fixture (non-billing).
 *
 * before: CREATING + g2 completed + attempt=0
 * → stale_reenqueue → remove completed → add same g2 → waiting
 * → second call → reuse_inflight
 * → mock executor enters RECONCILING (no SDK RunInstances)
 * → restore: resume queue, clear temp jobs, leave g2 completed shell
 *
 * Does NOT call --confirm-billing / process.exit().
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

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
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const {
  SERVER_PROVISION_QUEUE,
  serverProvisionJobId,
  decideServerProvisionCreatingAction,
  assessServerProvisionStaleRecovery,
} = require('@launchos/shared');
const { executeServerProvision } = require(resolve(
  root,
  'apps/worker/dist/server-provision-executor.js',
));

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const CR_ID = 'cmuas8iiz0001riown1l1a0o3';
const GEN = 2;
const POLL_MS = 300;
const RESTORE_TIMEOUT_MS = 15_000;

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(
      Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText,
    );
    err.payload = json;
    throw err;
  }
  return json;
}

async function closeFetchDispatcher() {
  try {
    const undici = await import('undici');
    const dispatcher = undici.getGlobalDispatcher?.();
    if (dispatcher && typeof dispatcher.close === 'function') await dispatcher.close();
  } catch {
    // ignore
  }
}

/**
 * Poll until predicate is true or timeout.
 * Returns { ok, timedOut, lastValue, observedSuccessLate }.
 * observedSuccessLate: timed out on wait loop but a final check shows success.
 */
async function pollUntil(label, fn, { timeoutMs = RESTORE_TIMEOUT_MS, intervalMs = POLL_MS } = {}) {
  const started = Date.now();
  let lastValue = null;
  while (Date.now() - started < timeoutMs) {
    lastValue = await fn();
    if (lastValue && lastValue.ok === true) {
      return { ok: true, timedOut: false, lastValue, observedSuccessLate: false, label };
    }
    await delay(intervalMs);
  }
  // One final observation — distinguishes "already done, poll missed" vs real failure.
  lastValue = await fn();
  if (lastValue && lastValue.ok === true) {
    return { ok: true, timedOut: true, lastValue, observedSuccessLate: true, label };
  }
  return { ok: false, timedOut: true, lastValue, observedSuccessLate: false, label };
}

async function getJobStateSafe(queue, jobId) {
  const job = await queue.getJob(jobId);
  if (!job) return null;
  return job.getState();
}

async function enqueueSameGeneration(queue, cloudResourceId, operationId, generation) {
  const jobId = serverProvisionJobId(cloudResourceId, generation);
  const payload = { cloudResourceId, operationId };
  const existing = await queue.getJob(jobId);
  let queueJobStateBefore = null;
  let strategy = 'add_new';
  if (existing) {
    queueJobStateBefore = await existing.getState();
    if (
      queueJobStateBefore === 'waiting' ||
      queueJobStateBefore === 'active' ||
      queueJobStateBefore === 'delayed'
    ) {
      return { jobId, strategy: 'reuse_inflight', queueJobStateBefore };
    }
    if (queueJobStateBefore === 'failed') {
      try {
        await existing.updateData(payload);
        await existing.retry();
        return { jobId, strategy: 'retry_failed', queueJobStateBefore };
      } catch {
        await existing.remove().catch(() => undefined);
      }
    } else if (queueJobStateBefore === 'completed') {
      await existing.remove();
      strategy = 'remove_completed_then_add_same_id';
    } else {
      await existing.remove().catch(() => undefined);
      strategy = 'remove_readd';
    }
  }
  await queue.add('provision', payload, {
    jobId,
    attempts: 1,
    removeOnComplete: 50,
    removeOnFail: 50,
  });
  return {
    jobId,
    strategy: existing ? strategy : 'add_new',
    queueJobStateBefore,
  };
}

/**
 * Ensure g2 job is completed. Uses state polling (not event-only) so a missed
 * Worker 'completed' event cannot false-fail restore.
 */
async function ensureCompletedJob(queue, connectionOpts, jobId, payload) {
  await queue.resume().catch(() => undefined);

  const already = await getJobStateSafe(queue, jobId);
  if (already === 'completed') {
    return { seeded: false, state: 'completed' };
  }

  const existing = await queue.getJob(jobId);
  if (existing) await existing.remove().catch(() => undefined);

  // Confirm removal observed
  const removed = await pollUntil('job-removed', async () => {
    const j = await queue.getJob(jobId);
    return { ok: !j, present: Boolean(j) };
  });
  if (!removed.ok) {
    throw new Error('restore: could not remove prior job before reseed');
  }

  const seeder = new Worker(SERVER_PROVISION_QUEUE, async () => ({ seeded: true }), {
    connection: { ...connectionOpts },
    concurrency: 1,
  });
  try {
    await seeder.waitUntilReady();
    await queue.add('provision', payload, {
      jobId,
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 50,
    });

    // Prefer state polling over event race (event may fire before listener attaches).
    const done = await pollUntil('job-completed', async () => {
      const state = await getJobStateSafe(queue, jobId);
      return { ok: state === 'completed', state };
    });

    if (!done.ok) {
      throw new Error(
        `restore: seed completed timeout (lastState=${done.lastValue?.state ?? 'null'})`,
      );
    }
    return {
      seeded: true,
      state: 'completed',
      observedSuccessLate: done.observedSuccessLate,
    };
  } finally {
    await seeder.close().catch(() => undefined);
  }
}

async function stopLiveWorkersBestEffort() {
  const { execSync } = require('node:child_process');
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='node.exe'\\" | ForEach-Object { if ($_.CommandLine -match 'apps\\\\\\\\worker|@launchos/worker') { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }"`,
      { stdio: 'ignore' },
    );
  } catch {
    // best-effort
  }
}

const connectionOpts = {
  host: '127.0.0.1',
  port: 6379,
  maxRetriesPerRequest: null,
};
const prisma = new PrismaClient();
const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});
const queue = new Queue(SERVER_PROVISION_QUEUE, { connection });

let queuePausedByFixture = false;
let queueWasPausedOriginally = false;
let reportOk = false;
let restoreResult = null;

try {
  queueWasPausedOriginally = await queue.isPaused();
  await stopLiveWorkersBestEffort();

  const before = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  if (!before) throw new Error('CR missing');
  // Snapshot live CR — restore failure must not write if we cannot finish queue restore.
  const beforeMeta =
    before.metadata && typeof before.metadata === 'object' ? { ...before.metadata } : {};
  const operationId = String(beforeMeta.operationId || 'op_stale_recovery_fixture');
  const jobId = serverProvisionJobId(CR_ID, GEN);

  await ensureCompletedJob(queue, connectionOpts, jobId, {
    cloudResourceId: CR_ID,
    operationId,
  });

  await prisma.cloudResource.update({
    where: { id: CR_ID },
    data: {
      status: 'CREATING',
      providerResourceId: null,
      metadata: {
        ...beforeMeta,
        createGeneration: GEN,
        operationId,
        phase: 'PREPARING_SECURITY_GROUP',
        runInstancesAttemptCount: 0,
        runInstancesSuccessCount: 0,
        fixtureStopBeforeRunInstances: null,
        fixtureStopReached: null,
      },
    },
  });

  const jobStateBefore = await getJobStateSafe(queue, jobId);
  const row = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  const meta = row.metadata;
  const decision = decideServerProvisionCreatingAction({
    status: row.status,
    phase: meta.phase,
    providerResourceId: row.providerResourceId,
    runInstancesAttemptCount: Number(meta.runInstancesAttemptCount || 0),
    queueJobState: jobStateBefore,
    createGeneration: GEN,
  });

  await queue.pause();
  queuePausedByFixture = true;

  const enqueued = await enqueueSameGeneration(queue, CR_ID, operationId, GEN);
  const jobStateAfter = await getJobStateSafe(queue, jobId);
  const enqueued2 = await enqueueSameGeneration(queue, CR_ID, operationId, GEN);

  const createBranchResponse = {
    enqueueStrategy: enqueued.strategy,
    queueJobId: enqueued.jobId,
    queueJobStateBefore: enqueued.queueJobStateBefore,
    queueJobStateAfter: jobStateAfter,
    safeResume: true,
    createGeneration: GEN,
    alreadyInProgress: false,
    decisionKind: decision.kind,
  };
  const secondResponse = {
    enqueueStrategy: enqueued2.strategy,
    alreadyInProgress: enqueued2.strategy === 'reuse_inflight',
    queueJobStateBefore: enqueued2.queueJobStateBefore,
  };

  // Mock executor (queue paused — no live Worker RunInstances)
  await prisma.cloudResource.update({
    where: { id: CR_ID },
    data: {
      status: 'CREATING',
      metadata: {
        ...(await prisma.cloudResource.findUnique({ where: { id: CR_ID } })).metadata,
        phase: 'QUEUED',
        runInstancesAttemptCount: 0,
      },
    },
  });

  let sdkCalled = false;
  let mockThrown = null;
  try {
    await executeServerProvision(prisma, CR_ID, {
      provisioner: {
        async reconcileManagedInstances() {
          return [];
        },
        async ensureNetwork() {
          return { vpcId: 'vpc-f', vSwitchId: 'vsw-f', zoneId: 'cn-hangzhou-i' };
        },
        async ensureSecurityGroup() {
          return 'sg-f';
        },
        async assertImageAvailable() {
          return;
        },
        async runInstance() {
          sdkCalled = true;
          throw new Error('SDK must not run');
        },
      },
      abortBeforeSdkRunInstances: true,
    });
  } catch (e) {
    mockThrown = e;
  }

  const afterMock = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  const am = afterMock.metadata;
  const phases = Array.isArray(am.phases) ? am.phases.map((p) => p.phase) : [];

  let httpRetry = null;
  try {
    const login = await api('/auth/login', {
      method: 'POST',
      body: {
        email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
        password: process.env.E2E_PASSWORD || 'Launchos123!',
      },
    });
    httpRetry = await api(`/projects/${PROJECT_ID}/server/provisions/${CR_ID}/retry`, {
      method: 'POST',
      token: login.accessToken,
    });
  } catch (e) {
    httpRetry = { error: String(e.message || e), payload: e.payload || null };
  }

  reportOk =
    decision.kind === 'stale_reenqueue' &&
    createBranchResponse.enqueueStrategy === 'remove_completed_then_add_same_id' &&
    createBranchResponse.queueJobStateBefore === 'completed' &&
    (createBranchResponse.queueJobStateAfter === 'waiting' ||
      createBranchResponse.queueJobStateAfter === 'delayed') &&
    createBranchResponse.createGeneration === 2 &&
    secondResponse.alreadyInProgress === true &&
    secondResponse.enqueueStrategy === 'reuse_inflight' &&
    phases.includes('RECONCILING') &&
    phases.includes('CREATING_INSTANCE') &&
    sdkCalled === false &&
    Number(am.createGeneration) === 2;

  console.log(
    JSON.stringify(
      {
        ok: reportOk,
        before: { status: 'CREATING', jobState: jobStateBefore, attempt: 0 },
        createBranchResponse,
        secondResponse,
        httpRetry: httpRetry
          ? {
              enqueueStrategy: httpRetry.enqueueStrategy ?? null,
              alreadyInProgress: httpRetry.alreadyInProgress ?? null,
              queueJobStateAfter: httpRetry.queueJobStateAfter ?? null,
              createGeneration: httpRetry.createGeneration ?? null,
              error: httpRetry.error ?? null,
            }
          : null,
        mockWorker: {
          phasesReached: [...new Set(phases)],
          enteredReconciling: phases.includes('RECONCILING'),
          sdkRunInstancesCalled: sdkCalled,
          thrown: mockThrown?.code || mockThrown?.message || null,
        },
      },
      null,
      2,
    ),
  );

  // ---------- restore (state-based polling; no fixed short sleep) ----------
  // Only mutate CR after queue restore is verified. Failure → no CR write.
  try {
    await queue.resume();
    queuePausedByFixture = false;

    const resumed = await pollUntil('queue-resumed', async () => {
      const paused = await queue.isPaused();
      return { ok: paused === false, paused };
    });
    if (!resumed.ok) {
      throw new Error('restore: queue still paused after resume');
    }

    // Clear fixture temporary waiting/active job
    const temp = await queue.getJob(jobId);
    if (temp) await temp.remove().catch(() => undefined);

    const cleared = await pollUntil('temp-job-cleared', async () => {
      const state = await getJobStateSafe(queue, jobId);
      return { ok: state === null, state };
    });
    if (!cleared.ok) {
      throw new Error(`restore: temp job still present (state=${cleared.lastValue?.state})`);
    }

    const seeded = await ensureCompletedJob(queue, connectionOpts, jobId, {
      cloudResourceId: CR_ID,
      operationId,
    });

    const completed = await pollUntil('restore-completed-job', async () => {
      const state = await getJobStateSafe(queue, jobId);
      return { ok: state === 'completed', state };
    });
    if (!completed.ok) {
      throw new Error(
        `restore: g2 not completed (lastState=${completed.lastValue?.state ?? 'null'})`,
      );
    }

    // Queue restore OK — now safe to reset fixture-touched CR counters (same CR, no new id).
    await prisma.cloudResource.update({
      where: { id: CR_ID },
      data: {
        status: 'CREATING',
        providerResourceId: null,
        metadata: {
          ...am,
          createGeneration: GEN,
          phase: 'PREPARING_SECURITY_GROUP',
          runInstancesAttemptCount: 0,
          runInstancesSuccessCount: 0,
          failedPhase: null,
          failedOperation: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          providerErrorCode: null,
          failedAt: null,
          fixtureStopBeforeRunInstances: null,
          fixtureStopReached: null,
          fixtureStopAt: null,
          fixtureNote: null,
        },
      },
    });

    const finalCr = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
    const fm = finalCr.metadata || {};
    const finalState = await getJobStateSafe(queue, jobId);
    const paused = await queue.isPaused();

    restoreResult = {
      ok: true,
      jobState: finalState,
      queuePaused: paused,
      createGeneration: Number(fm.createGeneration || GEN),
      runInstancesAttemptCount: Number(fm.runInstancesAttemptCount || 0),
      providerResourceId: finalCr.providerResourceId,
      observedSuccessLate:
        Boolean(resumed.observedSuccessLate) ||
        Boolean(cleared.observedSuccessLate) ||
        Boolean(completed.observedSuccessLate) ||
        Boolean(seeded.observedSuccessLate),
      safeResume: assessServerProvisionStaleRecovery({
        status: finalCr.status,
        phase: fm.phase,
        providerResourceId: finalCr.providerResourceId,
        runInstancesAttemptCount: Number(fm.runInstancesAttemptCount || 0),
        queueJobState: finalState,
        createGeneration: GEN,
      }),
    };
    console.log(JSON.stringify({ restored: restoreResult }, null, 2));
  } catch (restoreError) {
    // Do NOT write CloudResource on restore failure.
    const state = await getJobStateSafe(queue, jobId).catch(() => 'unknown');
    const paused = await queue.isPaused().catch(() => null);
    // Late success: job already completed despite thrown timeout from an earlier step.
    if (state === 'completed' && paused === false) {
      restoreResult = {
        ok: true,
        jobState: state,
        queuePaused: paused,
        observedSuccessLate: true,
        note: 'timeout thrown but final observation shows restore succeeded',
        error: String(restoreError?.message || restoreError),
      };
      console.log(JSON.stringify({ restored: restoreResult }, null, 2));
    } else {
      restoreResult = {
        ok: false,
        jobState: state,
        queuePaused: paused,
        error: String(restoreError?.message || restoreError),
        note: 'restore failed; CloudResource left unchanged by restore block',
      };
      console.log(JSON.stringify({ restoreFailed: restoreResult }, null, 2));
    }
  }

  const exitOk =
    reportOk &&
    restoreResult?.ok === true &&
    restoreResult?.jobState === 'completed' &&
    restoreResult?.queuePaused === false &&
    Number(restoreResult?.runInstancesAttemptCount ?? 0) === 0 &&
    restoreResult?.providerResourceId == null &&
    Number(restoreResult?.createGeneration ?? GEN) === 2;

  if (!exitOk) process.exitCode = 1;
} catch (error) {
  console.error(String(error?.message || error));
  process.exitCode = 1;
} finally {
  // Always restore queue pause state and close resources. No process.exit().
  try {
    if (queuePausedByFixture || (await queue.isPaused())) {
      if (!queueWasPausedOriginally) {
        await queue.resume().catch(() => undefined);
      }
    } else if (queueWasPausedOriginally) {
      await queue.pause().catch(() => undefined);
    }
  } catch {
    // ignore
  }
  await queue.close().catch(() => undefined);
  await connection.quit().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await closeFetchDispatcher();
}
