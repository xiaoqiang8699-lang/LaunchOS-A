const { PrismaClient } = require('../generated/client');
const p = new PrismaClient();
(async () => {
  const projectId = 'cmu3j24mv0001ri7wcsoa30hj';
  const reqs = await p.runtimeConfigRequirement.findMany({
    where: { projectId, key: { in: ['SENTRY_DSN', 'DATABASE_URL'] } },
    select: { deployableUnitId: true, key: true, label: true, injectionPhase: true },
  });
  const vals = await p.runtimeConfigValue.findMany({
    where: { projectId, key: { in: ['SENTRY_DSN', 'DATABASE_URL'] } },
    select: { scopeType: true, scopeId: true, key: true, deployableUnitId: true },
  });
  const units = await p.deployableUnit.findMany({
    where: { projectId },
    select: { id: true, name: true, configRevision: true, rootPath: true },
  });
  console.log(JSON.stringify({ units, reqs, vals }, null, 2));
})().finally(() => p.$disconnect());
