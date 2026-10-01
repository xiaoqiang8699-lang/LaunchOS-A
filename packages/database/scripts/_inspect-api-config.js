const { PrismaClient } = require('../generated/client');
const p = new PrismaClient();
(async () => {
  const api = 'cmu3j272x0005ri7wlxlbajeu';
  const reqs = await p.runtimeConfigRequirement.findMany({
    where: { deployableUnitId: api },
    select: { key: true, required: true },
  });
  const vals = await p.runtimeConfigValue.findMany({
    where: { projectId: 'cmu3j24mv0001ri7wcsoa30hj' },
    select: { scopeType: true, scopeId: true, key: true },
  });
  console.log(JSON.stringify({ reqs, vals }, null, 2));
})().finally(() => p.$disconnect());
