/**
 * One-shot non-sensitive queue connection diagnostic.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function loadDotEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // optional
  }
}

loadDotEnv(resolve(root, '.env'));
loadDotEnv(resolve(root, 'apps/worker/.env'));
loadDotEnv(resolve(root, 'apps/api/.env'));

const { Queue } = require(resolve(root, 'apps/worker/node_modules/bullmq'));
const {
  getRedisConnection,
  getRedisUrl,
  DATABASE_PROVISION_QUEUE,
  DEPLOYMENT_QUEUE,
  SYSTEM_CERT_QUEUE,
} = require(resolve(root, 'packages/shared/dist/index.js'));

const u = new URL(getRedisUrl());
const connection = getRedisConnection();
console.log(
  JSON.stringify(
    {
      queues: {
        databaseProvision: DATABASE_PROVISION_QUEUE,
        deployment: DEPLOYMENT_QUEUE,
        systemCert: SYSTEM_CERT_QUEUE,
      },
      redis: {
        host: connection.host,
        port: connection.port,
        db: (u.pathname || '/0').replace('/', '') || '0',
        hasPassword: Boolean(connection.password),
        hasUsername: Boolean(connection.username),
      },
    },
    null,
    2,
  ),
);

const q = new Queue(DATABASE_PROVISION_QUEUE, { connection });
const jobId = 'db-provision-cmu4110xm0001ric027vr0tc3';
const counts = await q.getJobCounts(
  'waiting',
  'active',
  'completed',
  'failed',
  'delayed',
  'paused',
);
const paused = await q.isPaused();
const workers = await q.getWorkers();
const job = await q.getJob(jobId);
const state = job ? await job.getState() : null;
const active = await q.getJobs(['active'], 0, 20);
const waiting = await q.getJobs(['waiting'], 0, 20);

console.log(
  JSON.stringify(
    {
      prefix: q.opts?.prefix || 'bull',
      isPaused: paused,
      counts,
      workers: workers.map((w) => ({
        id: w.id,
        addr: w.addr,
        name: w.name,
        age: w.age,
      })),
      targetJob: job
        ? {
            id: job.id,
            name: job.name,
            state,
            attemptsMade: job.attemptsMade,
            processedOn: job.processedOn,
            timestamp: job.timestamp,
            delay: job.delay,
            opts: {
              attempts: job.opts?.attempts,
              backoff: job.opts?.backoff,
              jobId: job.opts?.jobId,
            },
          }
        : null,
      activeJobs: active.map((j) => ({ id: j.id, name: j.name, dataKeys: Object.keys(j.data || {}) })),
      waitingJobs: waiting.map((j) => ({ id: j.id, name: j.name })),
    },
    null,
    2,
  ),
);

await q.close();
