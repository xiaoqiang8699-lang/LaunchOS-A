const { PrismaClient } = require('../generated/client');
const p = new PrismaClient();
p.deployment
  .findMany({
    where: { projectId: 'cmu3j24mv0001ri7wcsoa30hj', status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: {
      id: true,
      deployableUnitId: true,
      errorMessage: true,
      createdAt: true,
    },
  })
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .finally(() => p.$disconnect());
