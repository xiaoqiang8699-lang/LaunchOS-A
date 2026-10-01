const { PrismaClient } = require('../generated/client');
const p = new PrismaClient();
p.deployment
  .findUnique({
    where: { id: 'cmu2k4ph6000fri68124rf9xs' },
    select: { id: true, status: true, errorMessage: true, finishedAt: true },
  })
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    return p.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await p.$disconnect();
    process.exit(1);
  });
