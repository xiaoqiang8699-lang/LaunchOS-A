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
const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { PrismaClient } = require('@launchos/database');
const { SERVER_PROVISION_QUEUE, serverProvisionJobId } = require('@launchos/shared');

const id = 'cmuas8iiz0001riown1l1a0o3';
const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});
const q = new Queue(SERVER_PROVISION_QUEUE, { connection });
const jobId = serverProvisionJobId(id, 2);
const job = await q.getJob(jobId);
const p = new PrismaClient();
const r = await p.cloudResource.findUnique({ where: { id } });
const m = r?.metadata && typeof r.metadata === 'object' ? r.metadata : {};

console.log(
  JSON.stringify(
    {
      job: job
        ? {
            id: job.id,
            name: job.name,
            state: await job.getState(),
            returnvalue: job.returnvalue ?? null,
            failedReason: job.failedReason || null,
            attemptsMade: job.attemptsMade,
            processedOn: job.processedOn || null,
            finishedOn: job.finishedOn || null,
            data: job.data,
          }
        : null,
      cr: {
        status: r?.status,
        phase: m.phase,
        createGeneration: m.createGeneration,
        fixtureStopBeforeRunInstances: m.fixtureStopBeforeRunInstances ?? null,
        fixtureStopReached: m.fixtureStopReached ?? null,
        fixtureStopAt: m.fixtureStopAt ?? null,
        fixtureNote: m.fixtureNote ?? null,
        runInstancesAttemptCount: m.runInstancesAttemptCount ?? 0,
        providerResourceId: r?.providerResourceId ?? null,
      },
    },
    null,
    2,
  ),
);

await q.close();
await connection.quit();
await p.$disconnect();
