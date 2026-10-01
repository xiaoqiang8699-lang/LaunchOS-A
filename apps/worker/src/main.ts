import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import './env';
import { PrismaClient } from '@launchos/database';
import { DeploymentEngineService, reconcileRemoteRuntimes } from '@launchos/deployment';
import { SystemCertificateRenewalService } from '@launchos/domain';
import { RunnerService } from '@launchos/runner';
import { RuntimeService } from '@launchos/runtime';
import {
  DATABASE_PROVISION_QUEUE,
  REDIS_PROVISION_QUEUE,
  SERVER_PROVISION_QUEUE,
  SERVER_INITIALIZATION_QUEUE,
  DEPLOYMENT_QUEUE,
  SYSTEM_CERT_QUEUE,
  deploymentJobId,
  queuesForWorkerProfile,
  resolveWorkerProfile,
  getRedisConnection,
  getRedisEndpointLabel,
  isRetryableDeploymentError,
  redactSecrets,
  systemTlsRenewJobId,
  type DatabaseProvisionJobData,
  type RedisProvisionJobData,
  type ServerProvisionJobData,
  type ServerInitializationJobData,
  type DeploymentJobData,
  type SystemCertJobData,
} from '@launchos/shared';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { WorkerHeartbeatReporter } from './heartbeat';
import { startHealthMonitor } from './health-monitor';
import { startCodeSyncMonitor } from './code-sync';
import { executeDatabaseProvision } from './database-provision-executor';
import { executeRedisProvision } from './redis-provision-executor';
import { executeServerProvision } from './server-provision-executor';
import { executeServerInitialization } from './server-initialization-executor';
import { startSubscriptionLifecycle } from './subscription-lifecycle';
import { startPaymentReconciliation } from './payment-reconcile';

// Register early so async SSH probe failures cannot crash the worker before setup finishes.
process.on('uncaughtException', (error) => {
  console.error('worker degraded uncaughtException', error instanceof Error ? error.message : error);
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('worker degraded unhandledRejection', message);
});

const prisma = new PrismaClient();
const engine = new DeploymentEngineService(prisma, new RunnerService(), new RuntimeService());
const certRenewal = new SystemCertificateRenewalService(prisma);
const workerProfile = resolveWorkerProfile(process.env.WORKER_PROFILE);
const activeQueues = queuesForWorkerProfile(workerProfile);
const profileIncludes = (queue: string) => activeQueues.includes(queue);
const stopHealthMonitor = workerProfile === 'all' ? startHealthMonitor(prisma) : () => undefined;
const stopCodeSyncMonitor = workerProfile === 'all' ? startCodeSyncMonitor(prisma) : () => undefined;
const heartbeat = new WorkerHeartbeatReporter(prisma, {
  version: `redis-sku-resolved-${new Date().toISOString().slice(0, 10)}`,
});
heartbeat.setConsumedQueues(activeQueues);
let shuttingDown = false;
const deploymentWorkerLockPath = resolvePath(process.cwd(), '.deployment-worker.lock');

function releaseDeploymentWorkerLock(): void {
  if (workerProfile !== 'deployment') return;
  try {
    if (!existsSync(deploymentWorkerLockPath)) return;
    const owner = Number(readFileSync(deploymentWorkerLockPath, 'utf8').trim());
    if (!Number.isFinite(owner) || owner === process.pid) {
      unlinkSync(deploymentWorkerLockPath);
    }
  } catch {
    // ignore lock cleanup failures during shutdown
  }
}

function acquireDeploymentWorkerLock(): void {
  if (workerProfile !== 'deployment') return;
  if (existsSync(deploymentWorkerLockPath)) {
    const owner = Number(readFileSync(deploymentWorkerLockPath, 'utf8').trim());
    if (Number.isFinite(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
        console.error(`single-instance lock held by pid=${owner}; refusing second deployment worker`);
        process.exit(1);
      } catch {
        // stale lock from a previous crash
      }
    }
  }
  writeFileSync(deploymentWorkerLockPath, `${process.pid}\n`, 'utf8');
}

acquireDeploymentWorkerLock();
console.log(`worker profile=${workerProfile} queues=${activeQueues.join(',')}`);

const redisLabel = getRedisEndpointLabel();
const redisConn = getRedisConnection();
console.log(`queue connecting redis=${redisLabel}`);
console.log(
  `queue redis host=${redisConn.host} port=${redisConn.port} db=0 prefix=bull (password redacted)`,
);
console.log(
  `queue names deployment=${DEPLOYMENT_QUEUE} systemCert=${SYSTEM_CERT_QUEUE} databaseProvision=${DATABASE_PROVISION_QUEUE} redisProvision=${REDIS_PROVISION_QUEUE} serverProvision=${SERVER_PROVISION_QUEUE} serverInitialization=${SERVER_INITIALIZATION_QUEUE}`,
);

const connection = getRedisConnection();

const deploymentQueue = new Queue<DeploymentJobData>(DEPLOYMENT_QUEUE, { connection });
const certQueue = new Queue<SystemCertJobData>(SYSTEM_CERT_QUEUE, { connection });
const databaseProvisionQueue = new Queue<DatabaseProvisionJobData | { kind: 'kick' }>(
  DATABASE_PROVISION_QUEUE,
  {
    connection,
  },
);
const redisProvisionQueue = new Queue<RedisProvisionJobData | { kind: 'kick' }>(
  REDIS_PROVISION_QUEUE,
  {
    connection,
  },
);
const serverProvisionQueue = new Queue<ServerProvisionJobData | { kind: 'kick' }>(
  SERVER_PROVISION_QUEUE,
  {
    connection,
  },
);
const serverInitializationQueue = new Queue<ServerInitializationJobData | { kind: 'kick' }>(
  SERVER_INITIALIZATION_QUEUE,
  {
    connection,
  },
);

async function enqueueDeploymentJob(deploymentId: string, maxRetry: number): Promise<string> {
  const jobId = deploymentJobId(deploymentId);
  const existing = await deploymentQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'waiting' || state === 'active' || state === 'delayed') {
      return String(existing.id);
    }
    await existing.remove().catch(() => undefined);
  }
  const job = await deploymentQueue.add(
    'execute',
    { deploymentId },
    {
      jobId,
      attempts: Math.max(1, maxRetry),
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );
  return String(job.id);
}

async function getJobState(jobId: string): Promise<string | null> {
  const job = await deploymentQueue.getJob(jobId);
  if (!job) {
    return null;
  }
  return job.getState();
}

async function hasActiveJob(jobId: string | null): Promise<boolean> {
  if (!jobId) {
    return false;
  }
  const state = await getJobState(jobId);
  return state === 'active' || state === 'waiting' || state === 'delayed';
}

const STALE_SWEEP_MS = 60_000;
const RUNTIME_RECONCILE_MS = 5 * 60_000;

if (workerProfile === 'all') {
  void reconcileRemoteRuntimes(prisma)
    .then((report) => {
      console.log(
        `runtime reconcile startup staleCreating=${report.staleCreating} orphansRemoved=${report.orphanContainersRemoved} warnings=${report.warnings.length}`,
      );
    })
    .catch((error) => {
      console.error(
        'runtime reconcile startup failed',
        error instanceof Error ? error.message : error,
      );
    });
}

const runtimeReconcileTimer = workerProfile === 'all' ? setInterval(() => {
  void reconcileRemoteRuntimes(prisma)
    .then((report) => {
      if (
        report.staleCreating > 0 ||
        report.orphanContainersRemoved > 0 ||
        report.warnings.length > 0
      ) {
        console.log(
          `runtime reconcile staleCreating=${report.staleCreating} orphansRemoved=${report.orphanContainersRemoved} warnings=${report.warnings.length}`,
        );
      }
    })
    .catch((error) => {
      console.error(
        'runtime reconcile failed',
        error instanceof Error ? error.message : error,
      );
    });
}, RUNTIME_RECONCILE_MS) : null;

const stopSubscriptionLifecycle = workerProfile === 'all' ? startSubscriptionLifecycle(prisma) : () => undefined;
const stopPaymentReconciliation = workerProfile === 'all' ? startPaymentReconciliation(prisma) : () => undefined;
void stopPaymentReconciliation;

const staleSweepTimer = profileIncludes(DEPLOYMENT_QUEUE) ? setInterval(() => {
  void engine
    .failTimedOutDeployments({
      hasActiveJob,
      requeue: enqueueDeploymentJob,
    })
    .catch((error) => {
      console.error(
        'failTimedOutDeployments failed',
        error instanceof Error ? error.message : error,
      );
    });
}, STALE_SWEEP_MS) : null;

const deploymentWorker = profileIncludes(DEPLOYMENT_QUEUE) ? new Worker<DeploymentJobData>(
  DEPLOYMENT_QUEUE,
  async (job) => {
    const deploymentId = job.data.deploymentId;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    try {
      await engine.prepareAttempt(deploymentId, attempt);
      await engine.execute(deploymentId, {
        finalAttempt: attempt >= maxAttempts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryableDeploymentError(message)) {
        throw new UnrecoverableError(message);
      }
      throw error instanceof Error ? error : new Error(message);
    }
  },
  { connection },
) : null;

const certWorker = profileIncludes(SYSTEM_CERT_QUEUE) ? new Worker<SystemCertJobData>(
  SYSTEM_CERT_QUEUE,
  async (job) => {
    if (job.data.kind === 'check') {
      const decision = await certRenewal.checkAndEnqueueDecision();
      if (!decision.shouldRenew) {
        console.log(
          `System cert check: skip renew (${decision.reason}, days=${decision.daysRemaining})`,
        );
        return;
      }
      const config = await prisma.systemDomainConfig.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { rootDomain: true, renewalMode: true, dnsProviderAccountId: true },
      });
      if (!config || config.renewalMode !== 'AUTOMATIC_DNS' || !config.dnsProviderAccountId) {
        console.log('System cert check: AUTOMATIC_DNS not configured, skip');
        return;
      }
      const jobId = systemTlsRenewJobId(config.rootDomain);
      const existing = await certQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'active' || state === 'waiting' || state === 'delayed') {
          console.log(`System cert renew already queued: ${jobId}`);
          return;
        }
      }
      await certQueue.add(
        'renew',
        { kind: 'renew', rootDomain: config.rootDomain },
        { jobId, removeOnComplete: 50, removeOnFail: 50, attempts: 1 },
      );
      console.log(`System cert renew enqueued: ${jobId}`);
      return;
    }

    if (job.data.kind === 'renew') {
      await certRenewal.renew({
        force: Boolean(job.data.force),
        dryRun: Boolean(job.data.dryRun),
      });
    }
  },
  { connection },
) : null;

const databaseProvisionWorker = profileIncludes(DATABASE_PROVISION_QUEUE)
  ? new Worker<DatabaseProvisionJobData | { kind?: string }>(
  DATABASE_PROVISION_QUEUE,
  async (job) => {
    // Synthetic marker kick — never touches CloudResource / RDS.
    if (job.name === 'queue-kick' || (job.data as { kind?: string })?.kind === 'kick') {
      console.log('databaseProvisionQueue kick acknowledged');
      return;
    }
    const cloudResourceId = (job.data as DatabaseProvisionJobData).cloudResourceId;
    console.log(`database provision start resource=${cloudResourceId}`);
    await executeDatabaseProvision(prisma, cloudResourceId);
    console.log(`database provision done resource=${cloudResourceId}`);
  },
  { connection, lockDuration: 30 * 60_000, concurrency: 1 },
)
  : null;

const redisProvisionWorker = profileIncludes(REDIS_PROVISION_QUEUE)
  ? new Worker<RedisProvisionJobData | { kind?: string }>(
  REDIS_PROVISION_QUEUE,
  async (job) => {
    if (job.name === 'queue-kick' || (job.data as { kind?: string })?.kind === 'kick') {
      console.log('redisProvisionQueue kick acknowledged');
      return;
    }
    const cloudResourceId = (job.data as RedisProvisionJobData).cloudResourceId;
    console.log(`redis provision start resource=${cloudResourceId}`);
    await executeRedisProvision(prisma, cloudResourceId);
    console.log(`redis provision done resource=${cloudResourceId}`);
  },
  { connection, lockDuration: 30 * 60_000, concurrency: 1 },
)
  : null;

const serverProvisionWorker = profileIncludes(SERVER_PROVISION_QUEUE)
  ? new Worker<ServerProvisionJobData | { kind?: string }>(
  SERVER_PROVISION_QUEUE,
  async (job) => {
    if (job.name === 'queue-kick' || (job.data as { kind?: string })?.kind === 'kick') {
      console.log('serverProvisionQueue kick acknowledged');
      return;
    }
    const cloudResourceId = (job.data as ServerProvisionJobData).cloudResourceId;
    console.log(`server provision start resource=${cloudResourceId}`);
    await executeServerProvision(prisma, cloudResourceId);
    console.log(`server provision done resource=${cloudResourceId}`);
  },
  { connection, lockDuration: 30 * 60_000, concurrency: 1 },
)
  : null;

const serverInitializationWorker = profileIncludes(SERVER_INITIALIZATION_QUEUE)
  ? new Worker<ServerInitializationJobData | { kind?: string }>(
  SERVER_INITIALIZATION_QUEUE,
  async (job) => {
    if (job.name === 'queue-kick' || (job.data as { kind?: string })?.kind === 'kick') {
      console.log('serverInitializationQueue kick acknowledged');
      return;
    }
    const serverInstanceId = (job.data as ServerInitializationJobData).serverInstanceId;
    console.log(`server initialization start serverInstanceId=${serverInstanceId}`);
    try {
      await executeServerInitialization(prisma, serverInstanceId);
      console.log(`server initialization done serverInstanceId=${serverInstanceId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // attempts=1 — never auto-retry whole init chain
      throw new UnrecoverableError(redactSecrets(message));
    }
  },
  { connection, lockDuration: 30 * 60_000, concurrency: 1 },
)
  : null;

const DAY_MS = 24 * 60 * 60 * 1000;
const dailyCheckTimer = profileIncludes(SYSTEM_CERT_QUEUE) ? setInterval(() => {
  void certQueue
    .add(
      'check',
      { kind: 'check' },
      {
        jobId: `system-cert-check-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: 30,
        removeOnFail: 30,
        attempts: 1,
      },
    )
    .catch((error) => {
      console.error(
        'Failed to enqueue daily cert check',
        error instanceof Error ? error.message : error,
      );
    });
}, DAY_MS) : null;

const bootCertTimer = profileIncludes(SYSTEM_CERT_QUEUE)
  ? setTimeout(() => {
      void certQueue
        .add(
          'check',
          { kind: 'check' },
          {
            jobId: `system-cert-check-boot-${Date.now()}`,
            removeOnComplete: 10,
            removeOnFail: 10,
            attempts: 1,
          },
        )
        .catch(() => undefined);
    }, 15_000)
  : null;

async function boot(): Promise<void> {
  await heartbeat.start();
  if (!profileIncludes(DEPLOYMENT_QUEUE)) return;
  const reconcile = await engine.reconcileStaleDeployments({
    getJobState,
    requeue: enqueueDeploymentJob,
  });
  if (reconcile.fixed || reconcile.failed) {
    console.log(
      `reconcileStaleDeployments fixed=${reconcile.fixed} failed=${reconcile.failed}`,
    );
  }
  void engine
    .failTimedOutDeployments({ hasActiveJob, requeue: enqueueDeploymentJob })
    .catch(() => undefined);
}

void boot().catch((error) => {
  console.error('worker boot failed', error instanceof Error ? error.message : error);
});

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('worker shutdown begin');
  if (dailyCheckTimer) clearInterval(dailyCheckTimer);
  if (bootCertTimer) clearTimeout(bootCertTimer);
  if (staleSweepTimer) clearInterval(staleSweepTimer);
  if (runtimeReconcileTimer) clearInterval(runtimeReconcileTimer);
  stopSubscriptionLifecycle();
  stopHealthMonitor();
  stopCodeSyncMonitor();
  await heartbeat.stop();
  await deploymentWorker?.close();
  await certWorker?.close();
  await databaseProvisionWorker?.close();
  await redisProvisionWorker?.close();
  await serverProvisionWorker?.close();
  await serverInitializationWorker?.close();
  await deploymentQueue.close();
  await certQueue.close();
  await databaseProvisionQueue.close();
  await redisProvisionQueue.close();
  await serverProvisionQueue.close();
  await serverInitializationQueue.close();
  await prisma.$disconnect();
  releaseDeploymentWorkerLock();
  console.log('worker shutdown complete');
  process.exit(0);
}

deploymentWorker?.on('ready', () => {
  heartbeat.setQueueReady({ deployment: true });
  console.log('LaunchOS Worker started');
  console.log(`queue connected redis=${redisLabel}`);
  console.log(`worker ready queue=${DEPLOYMENT_QUEUE}`);
  console.log(`workerId=${heartbeat.workerId}`);
  heartbeat.setStatus('ONLINE');
  console.log('worker recovered');
});

certWorker?.on('ready', () => {
  heartbeat.setQueueReady({ systemCert: true });
  console.log(`worker ready queue=${SYSTEM_CERT_QUEUE}`);
});

databaseProvisionWorker?.on('ready', () => {
  heartbeat.setQueueReady({ databaseProvision: true });
  console.log(`worker ready queue=${DATABASE_PROVISION_QUEUE}`);
  console.log('databaseProvisionQueue consumer ready');
  void (async () => {
    try {
      const counts = await databaseProvisionQueue.getJobCounts('waiting', 'active', 'delayed');
      console.log(
        `databaseProvisionQueue counts waiting=${counts.waiting ?? 0} active=${counts.active ?? 0} delayed=${counts.delayed ?? 0}`,
      );
      // Unstick BullMQ v5 marker wedge: waiting jobs + idle BZPOPMIN without wakeup.
      if ((counts.waiting ?? 0) > 0 && (counts.active ?? 0) === 0) {
        await databaseProvisionQueue.add(
          'queue-kick',
          { kind: 'kick' },
          {
            removeOnComplete: 1,
            removeOnFail: 1,
            attempts: 1,
          },
        );
        console.log('databaseProvisionQueue marker kick enqueued (does not create CloudResource)');
      }
    } catch (error) {
      console.error(
        'databaseProvisionQueue ready probe failed',
        error instanceof Error ? error.message : error,
      );
    }
  })();
});

deploymentWorker?.on('completed', (job) => {
  console.log(`Deployment ${job.data.deploymentId} completed`);
});

deploymentWorker?.on('active', (job) => {
  console.log(`Deployment ${job.data.deploymentId} accepted`);
});

deploymentWorker?.on('failed', (job, error) => {
  const deploymentId = job?.data.deploymentId ?? 'unknown';
  console.error(`Deployment ${deploymentId} failed: ${redactSecrets(error.message)}`);
});

deploymentWorker?.on('error', (error) => {
  heartbeat.setStatus('DEGRADED');
  heartbeat.setQueueReady({ deployment: false });
  console.error('worker degraded', error instanceof Error ? error.message : error);
});

certWorker?.on('failed', (job, error) => {
  console.error(`System cert job ${job?.id ?? 'unknown'} failed: ${error.message}`);
});

certWorker?.on('error', (error) => {
  heartbeat.setStatus('DEGRADED');
  heartbeat.setQueueReady({ systemCert: false });
  console.error('worker degraded', error instanceof Error ? error.message : error);
});

databaseProvisionWorker?.on('completed', (job) => {
  const id = (job.data as DatabaseProvisionJobData)?.cloudResourceId ?? job.id;
  console.log(`database provision completed job=${job.id} resource=${id}`);
});

databaseProvisionWorker?.on('failed', (job, error) => {
  const id = (job?.data as DatabaseProvisionJobData | undefined)?.cloudResourceId ?? 'unknown';
  const safe = redactSecrets(error.message || String(error)).replace(
    /ClientToken=[^&\s]+/gi,
    'ClientToken=[REDACTED]',
  );
  console.error(`database provision failed resource=${id}: ${safe}`);
});

databaseProvisionWorker?.on('error', (error) => {
  heartbeat.setStatus('DEGRADED');
  heartbeat.setQueueReady({ databaseProvision: false });
  console.error(
    'databaseProvisionQueue consumer degraded',
    error instanceof Error ? error.message : error,
  );
});

redisProvisionWorker?.on('ready', () => {
  heartbeat.setQueueReady({ redisProvision: true });
  console.log(`worker ready queue=${REDIS_PROVISION_QUEUE}`);
  console.log('redisProvisionQueue consumer ready');
  void (async () => {
    try {
      const counts = await redisProvisionQueue.getJobCounts('waiting', 'active', 'delayed');
      console.log(
        `redisProvisionQueue counts waiting=${counts.waiting ?? 0} active=${counts.active ?? 0} delayed=${counts.delayed ?? 0}`,
      );
      if ((counts.waiting ?? 0) > 0 && (counts.active ?? 0) === 0) {
        await redisProvisionQueue.add(
          'queue-kick',
          { kind: 'kick' },
          { removeOnComplete: 1, removeOnFail: 1, attempts: 1 },
        );
        console.log('redisProvisionQueue marker kick enqueued (does not create CloudResource)');
      }
    } catch (error) {
      console.error(
        'redisProvisionQueue ready probe failed',
        error instanceof Error ? error.message : error,
      );
    }
  })();
});

redisProvisionWorker?.on('completed', (job) => {
  const id = (job.data as RedisProvisionJobData)?.cloudResourceId ?? job.id;
  console.log(`redis provision completed job=${job.id} resource=${id}`);
});

redisProvisionWorker?.on('failed', (job, error) => {
  const id = (job?.data as RedisProvisionJobData | undefined)?.cloudResourceId ?? 'unknown';
  const safe = redactSecrets(error.message || String(error));
  console.error(`redis provision failed resource=${id}: ${safe}`);
});

redisProvisionWorker?.on('error', (error) => {
  heartbeat.setStatus('DEGRADED');
  heartbeat.setQueueReady({ redisProvision: false });
  console.error(
    'redisProvisionQueue consumer degraded',
    error instanceof Error ? error.message : error,
  );
});

serverProvisionWorker?.on('ready', () => {
  heartbeat.setQueueReady({ serverProvision: true });
  console.log(`worker ready queue=${SERVER_PROVISION_QUEUE}`);
  console.log('serverProvisionQueue consumer ready');
});

serverProvisionWorker?.on('completed', (job) => {
  const id = (job.data as ServerProvisionJobData)?.cloudResourceId ?? job.id;
  console.log(`server provision completed job=${job.id} resource=${id}`);
});

serverProvisionWorker?.on('failed', (job, error) => {
  const id = (job?.data as ServerProvisionJobData | undefined)?.cloudResourceId ?? 'unknown';
  const safe = redactSecrets(error.message || String(error));
  console.error(`server provision failed resource=${id}: ${safe}`);
});

serverProvisionWorker?.on('error', (error) => {
  heartbeat.setStatus('DEGRADED');
  heartbeat.setQueueReady({ serverProvision: false });
  console.error(
    'serverProvisionQueue consumer degraded',
    error instanceof Error ? error.message : error,
  );
});

serverInitializationWorker?.on('ready', () => {
  heartbeat.setQueueReady({ serverInitialization: true });
  console.log(`worker ready queue=${SERVER_INITIALIZATION_QUEUE}`);
  console.log('serverInitializationQueue consumer ready');
});

serverInitializationWorker?.on('completed', (job) => {
  const id = (job.data as ServerInitializationJobData)?.serverInstanceId ?? job.id;
  console.log(`server initialization completed job=${job.id} serverInstanceId=${id}`);
});

serverInitializationWorker?.on('failed', (job, error) => {
  const id =
    (job?.data as ServerInitializationJobData | undefined)?.serverInstanceId ?? 'unknown';
  const safe = redactSecrets(error.message || String(error));
  console.error(`server initialization failed serverInstanceId=${id}: ${safe}`);
});

serverInitializationWorker?.on('error', (error) => {
  heartbeat.setStatus('DEGRADED');
  heartbeat.setQueueReady({ serverInitialization: false });
  console.error(
    'serverInitializationQueue consumer degraded',
    error instanceof Error ? error.message : error,
  );
});

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
