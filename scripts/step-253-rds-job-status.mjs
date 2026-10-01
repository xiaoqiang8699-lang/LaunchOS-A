/**
 * Read-only diagnostic for Step 25.3 stuck RDS provision job.
 *
 *   node scripts/step-253-rds-job-status.mjs
 *
 * Does NOT: enqueue, create RDS, delete, mutate CloudResource / DB rows.
 * Does NOT print AK/SK, DB password, or DATABASE_URL.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

loadDotEnv(resolve(root, '.env'));

const CLOUD_RESOURCE_ID = 'cmu4110xm0001ric027vr0tc3';
const QUEUE_NAME = 'databaseProvisionQueue';
const EXPECTED_JOB_ID = `db-provision-${CLOUD_RESOURCE_ID}`;

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { Queue } = require(resolve(root, 'apps/worker/node_modules/bullmq'));
const {
  getRedisConnection,
  decryptCredential,
  redactSecrets,
} = require(resolve(root, 'packages/shared/dist/index.js'));

const prisma = new PrismaClient();

function loadDotEnv(path) {
  try {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // optional
  }
}

function safeText(value) {
  if (value == null) return null;
  const text = String(value);
  const redacted = redactSecrets(text);
  return redacted
    .replace(/postgres:\/\/[^:\s]+:[^@\s]+@/gi, 'postgres://[REDACTED]@')
    .replace(/redis:\/\/[^:\s]+:[^@\s]+@/gi, 'redis://[REDACTED]@')
    .replace(/\b(LTAI[A-Za-z0-9]{8,})\b/g, '[REDACTED_AK]')
    .replace(/(accessKey|secretKey|AccessKeySecret|password)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

function asMeta(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function line(key, value) {
  console.log(`${key}: ${value === undefined || value === null || value === '' ? 'null' : value}`);
}

function workerSourceRegistersQueue() {
  try {
    const src = readFileSync(resolve(root, 'apps/worker/src/main.ts'), 'utf8');
    const hasConst = /DATABASE_PROVISION_QUEUE/.test(src);
    const hasWorker = /new Worker[\s\S]*DATABASE_PROVISION_QUEUE/.test(src);
    const hasQueue = /new Queue[\s\S]*DATABASE_PROVISION_QUEUE/.test(src);
    return hasConst && hasWorker && hasQueue;
  } catch {
    return false;
  }
}

async function describeRdsReadonly(providerResourceId, region, account) {
  if (!account?.credentialEncrypted) {
    return { error: 'no ALIYUN credentials for describe' };
  }
  const raw = decryptCredential(account.credentialEncrypted);
  const secrets = JSON.parse(raw);
  if (!secrets.accessKey || !secrets.secretKey) {
    return { error: 'invalid credential payload' };
  }
  const { AlibabaCloudDatabaseProvider } = require(
    resolve(root, 'packages/providers/dist/index.js'),
  );
  const provider = new AlibabaCloudDatabaseProvider({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region: region || 'cn-hangzhou',
  });
  const status = await provider.getInstanceStatus(providerResourceId);
  return {
    providerResourceId,
    status: status.rawStatus || status.status,
    region: region || 'cn-hangzhou',
  };
}

function conclude({ resource, jobState, providerStatus }) {
  const meta = asMeta(resource.metadata);
  const phase = meta.phase || null;
  const hasProviderId = Boolean(resource.providerResourceId);
  const status = resource.status;

  if (!jobState) {
    if (status === 'RUNNING' && hasProviderId) return 'D. job completed but E2E polling stuck';
    if (hasProviderId && status === 'CREATING') return 'E. RDS already exists but post-provision step stuck';
    return 'F. no queue job found';
  }

  if (jobState === 'waiting' || jobState === 'delayed' || jobState === 'prioritized' || jobState === 'wait') {
    return 'A. job still waiting';
  }
  if (jobState === 'active') {
    if (hasProviderId && (phase === 'CREATING_INSTANCE' || phase === 'PREPARING_NETWORK' || !phase || phase === 'QUEUED')) {
      return 'B. job active and polling provider';
    }
    if (hasProviderId && phase && phase !== 'DONE' && phase !== 'FAILED') {
      return 'E. RDS already exists but post-provision step stuck';
    }
    return 'B. job active and polling provider';
  }
  if (jobState === 'failed') {
    return 'C. job failed';
  }
  if (jobState === 'completed') {
    if (status === 'RUNNING') return 'D. job completed but E2E polling stuck';
    if (hasProviderId && status !== 'RUNNING') return 'E. RDS already exists but post-provision step stuck';
    return 'D. job completed but E2E polling stuck';
  }
  return `F. no queue job found (state=${jobState})`;
}

let queue;
try {
  const resource = await prisma.cloudResource.findUnique({
    where: { id: CLOUD_RESOURCE_ID },
    include: { provider: true },
  });

  if (!resource) {
    console.log(`CloudResource ${CLOUD_RESOURCE_ID} not found`);
    process.exitCode = 1;
  } else {
    const meta = asMeta(resource.metadata);

    section('1. CloudResource');
    line('id', resource.id);
    line('status', resource.status);
    line('resourceKind', meta.resourceKind || resource.type || null);
    line('providerResourceId', resource.providerResourceId);
    line('provisioningStep', meta.phase || null);
    line('progress', Array.isArray(meta.phases) ? `${meta.phases.length} phase events` : null);
    if (Array.isArray(meta.phases) && meta.phases.length) {
      const last = meta.phases[meta.phases.length - 1];
      line(
        'lastPhaseEvent',
        safeText(`${last?.phase || '?'} @ ${last?.at || '?'} (${last?.status || '?'})`),
      );
    }
    line('lastErrorCode', meta.errorCode || meta.providerErrorCode || null);
    line('lastErrorMessage', safeText(meta.errorMessage || meta.technicalMessage || null));
    line('providerRequestId', meta.providerRequestId || null);
    line('createdAt', resource.createdAt?.toISOString?.() || resource.createdAt);
    line('updatedAt', resource.updatedAt?.toISOString?.() || resource.updatedAt);

    section('2. BullMQ databaseProvisionQueue');
    queue = new Queue(QUEUE_NAME, { connection: getRedisConnection() });
    const job =
      (await queue.getJob(EXPECTED_JOB_ID)) ||
      (await queue.getJob(CLOUD_RESOURCE_ID)) ||
      null;

    let jobState = null;
    if (!job) {
      line('jobId', EXPECTED_JOB_ID);
      line('found', false);
      line('state', null);
      // Scan recent jobs for this resource id (read-only).
      const buckets = ['waiting', 'active', 'failed', 'completed', 'delayed'];
      for (const bucket of buckets) {
        const jobs = await queue.getJobs([bucket], 0, 100);
        const hit = jobs.find(
          (j) =>
            j.id === EXPECTED_JOB_ID ||
            j.data?.cloudResourceId === CLOUD_RESOURCE_ID,
        );
        if (hit) {
          jobState = await hit.getState();
          line('foundViaScan', `${bucket}/${hit.id}`);
          line('jobId', hit.id);
          line('state', jobState);
          line('attemptsMade', hit.attemptsMade);
          line('failedReason', safeText(hit.failedReason));
          line('processedOn', hit.processedOn ? new Date(hit.processedOn).toISOString() : null);
          line('finishedOn', hit.finishedOn ? new Date(hit.finishedOn).toISOString() : null);
          break;
        }
      }
      if (!jobState) {
        line('counts', JSON.stringify(await queue.getJobCounts('waiting', 'active', 'failed', 'completed', 'delayed')));
      }
    } else {
      jobState = await job.getState();
      line('jobId', job.id);
      line('found', true);
      line('state', jobState);
      line('waiting/active/failed/completed/delayed', jobState);
      line('attemptsMade', job.attemptsMade);
      line('failedReason', safeText(job.failedReason));
      line('processedOn', job.processedOn ? new Date(job.processedOn).toISOString() : null);
      line('finishedOn', job.finishedOn ? new Date(job.finishedOn).toISOString() : null);
      line('data.cloudResourceId', job.data?.cloudResourceId || null);
      line('data.operationId', job.data?.operationId ? String(job.data.operationId).slice(0, 24) + '…' : null);
    }

    section('3. Worker queue registration');
    const sourceRegistered = workerSourceRegistersQueue();
    let liveWorkers = [];
    try {
      liveWorkers = await queue.getWorkers();
    } catch {
      liveWorkers = [];
    }
    const liveRegistered = Array.isArray(liveWorkers) && liveWorkers.length > 0;
    line('sourceCodeRegistersDatabaseProvisionQueue', sourceRegistered);
    line('registered', liveRegistered || sourceRegistered);
    line('liveWorkersOnQueue', liveWorkers.length);
    if (liveWorkers.length) {
      for (const w of liveWorkers.slice(0, 5)) {
        line(
          'worker',
          safeText(`id=${w.id || '?'} addr=${w.addr || w.name || '?'} age=${w.age ?? '?'}`),
        );
      }
    } else {
      line('note', 'No live BullMQ workers currently attached to databaseProvisionQueue');
    }

    section('4. Provider status (read-only)');
    let providerStatus = null;
    if (resource.providerResourceId) {
      const account = await prisma.providerAccount.findFirst({
        where: {
          workspaceId: resource.workspaceId,
          status: 'ACTIVE',
          provider: { type: 'ALIYUN' },
        },
        include: { provider: true },
        orderBy: { createdAt: 'asc' },
      });
      try {
        providerStatus = await describeRdsReadonly(
          resource.providerResourceId,
          resource.region || meta.region,
          account,
        );
        line('providerResourceId', providerStatus.providerResourceId || resource.providerResourceId);
        line('status', providerStatus.status || providerStatus.error || null);
        line('region', providerStatus.region || resource.region || meta.region || null);
      } catch (err) {
        line('providerResourceId', resource.providerResourceId);
        line('status', 'DESCRIBE_FAILED');
        line('region', resource.region || meta.region || null);
        line('describeError', safeText(err instanceof Error ? err.message : String(err)));
      }
    } else {
      line('providerResourceId', null);
      line('status', 'N/A (not created yet)');
      line('region', resource.region || meta.region || null);
    }

    section('5. Conclusion');
    const conclusion = conclude({
      resource,
      jobState,
      providerStatus,
    });
    console.log(conclusion);
    if (conclusion.startsWith('C.')) {
      line('failedStep', meta.phase || null);
      line('providerErrorCode', meta.providerErrorCode || meta.errorCode || null);
      line('requestId', meta.providerRequestId || null);
      line('failedReason', safeText(meta.errorMessage || meta.technicalMessage || null));
    }
    if (conclusion.startsWith('B.') || conclusion.startsWith('E.')) {
      line('currentProvisioningStep', meta.phase || null);
    }
  }
} finally {
  await prisma.$disconnect().catch(() => undefined);
  if (queue) await queue.close().catch(() => undefined);
}
