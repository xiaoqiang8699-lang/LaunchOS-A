import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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
const { DEPLOYMENT_WORKER_SERVICE } = require('@launchos/shared');
const prisma = new PrismaClient();
const hb = await prisma.workerHeartbeat.findFirst({
  where: { service: DEPLOYMENT_WORKER_SERVICE },
  orderBy: { lastSeenAt: 'desc' },
});
console.log(
  JSON.stringify(
    {
      workerId: hb?.workerId,
      status: hb?.status,
      lastSeenAt: hb?.lastSeenAt,
      queueReady: hb?.meta?.queueReady ?? null,
      consumedQueues: hb?.meta?.consumedQueues ?? null,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
