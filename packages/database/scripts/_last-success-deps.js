const { PrismaClient } = require('../generated/client');
const p = new PrismaClient();
(async () => {
  const deps = await p.deployment.findMany({
    where: {
      projectId: 'cmu3j24mv0001ri7wcsoa30hj',
      status: 'SUCCESS',
    },
    orderBy: { createdAt: 'desc' },
    take: 4,
    select: {
      id: true,
      deployableUnitId: true,
      configRevision: true,
      configFingerprint: true,
      configKeys: true,
      createdAt: true,
    },
  });
  console.log(JSON.stringify(deps, null, 2));
})().finally(() => p.$disconnect());
