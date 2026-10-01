import { PrismaClient } from '@launchos/database';
import { retirePlatformManagedNode } from './managed-node-registry';

const id = process.env.MANAGED_NODE_ID?.trim() || '';
if (!id) {
  console.error('需要运行时提供 MANAGED_NODE_ID。');
  process.exit(1);
}

const prisma = new PrismaClient();
retirePlatformManagedNode(prisma, id)
  .then((node) => {
    console.log(JSON.stringify({ id: node.id, status: node.status, scope: node.scope }));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : '下线失败');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
