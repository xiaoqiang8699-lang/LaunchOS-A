import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('../packages/database/generated/client');
const p = new PrismaClient();
const dep = await p.deployment.findFirst({
  where: {
    projectId: 'cmu3j24mv0001ri7wcsoa30hj',
    deployableUnitId: 'cmu3j272x0005ri7wlxlbajeu',
  },
  orderBy: { createdAt: 'desc' },
  select: { id: true, status: true, errorMessage: true },
});
console.log(JSON.stringify(dep));
const steps = await p.deploymentStep.findMany({
  where: { deploymentId: dep.id },
  orderBy: { createdAt: 'asc' },
  select: { stepKey: true, status: true, errorMessage: true },
});
for (const step of steps) {
  const msg = (step.errorMessage || '')
    .replace(/postgresql:\/\/[^\s]+/gi, 'postgresql://[REDACTED]')
    .replace(/PASSWORD=[^\s]+/gi, 'PASSWORD=[REDACTED]');
  console.log(`${step.stepKey} ${step.status} ${msg.slice(0, 200)}`);
}
const logs = await p.deploymentLog.findMany({
  where: { deploymentId: dep.id },
  orderBy: { createdAt: 'desc' },
  take: 8,
  select: { message: true },
});
for (const log of logs.reverse()) {
  const msg = (log.message || '')
    .replace(/postgresql:\/\/[^\s]+/gi, 'postgresql://[REDACTED]')
    .replace(/PASSWORD=[^\s]+/gi, 'PASSWORD=[REDACTED]');
  console.log(`LOG ${msg.slice(0, 220)}`);
}
await p.$disconnect();
