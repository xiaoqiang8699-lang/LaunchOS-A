const { PrismaClient } = require('../generated/client');
const p = new PrismaClient();
(async () => {
  const recent = await p.serviceInstance.findMany({
    where: { projectId: 'cmu3j24mv0001ri7wcsoa30hj' },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: {
      id: true,
      status: true,
      externalPort: true,
      internalPort: true,
      port: true,
      deployableUnitId: true,
      containerId: true,
      createdAt: true,
    },
  });
  const steps = await p.deploymentStep.findMany({
    where: {
      deployment: { projectId: 'cmu3j24mv0001ri7wcsoa30hj' },
      stepKey: 'DEPLOY_APPLICATION',
    },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { deploymentId: true, status: true, metadata: true, errorMessage: true },
  });
  console.log(JSON.stringify({ recent, steps }, null, 2));
})().finally(() => p.$disconnect());
