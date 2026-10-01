import { config } from 'dotenv';
import { resolve } from 'node:path';
import { Queue } from 'bullmq';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '../../.env') });
import { PrismaClient } from '@launchos/database';
import {
  DATABASE_PROVISION_QUEUE,
  DEPLOYMENT_QUEUE,
  REDIS_PROVISION_QUEUE,
  SERVER_PROVISION_QUEUE,
  getRedisConnection,
} from '@launchos/shared';

const connection = getRedisConnection();
const names = [DEPLOYMENT_QUEUE, SERVER_PROVISION_QUEUE, DATABASE_PROVISION_QUEUE, REDIS_PROVISION_QUEUE];
const prisma = new PrismaClient();
const queues = names.map((name) => new Queue(name, { connection }));
const counts = {};
for (const queue of queues) {
  const jobCounts = await queue.getJobCounts('waiting', 'active', 'delayed');
  const workers = await queue.getWorkers();
  counts[queue.name] = {
    waiting: jobCounts.waiting ?? 0,
    active: jobCounts.active ?? 0,
    delayed: jobCounts.delayed ?? 0,
    workers: workers.length,
  };
  await queue.close();
}
const running = await prisma.deployment.count({
  where: { status: { in: ['QUEUED', 'RUNNING', 'CREATED'] } },
});
console.log(JSON.stringify({ counts, inFlightDeployments: running }));
await prisma.$disconnect();
