import { PrismaClient } from '@launchos/database';
import { registerPlatformManagedNode } from './managed-node-registry';

const host = process.env.MANAGED_NODE_HOST?.trim() || '';
const username = process.env.MANAGED_NODE_USERNAME?.trim() || '';
const password = process.env.MANAGED_NODE_PASSWORD || '';
const name = process.env.MANAGED_NODE_NAME?.trim() || 'launchos-managed-node';
const port = Number(process.env.MANAGED_NODE_PORT || 22);

if (!host || !username || !password) {
  console.error(
    '需要运行时提供 MANAGED_NODE_HOST、MANAGED_NODE_USERNAME、MANAGED_NODE_PASSWORD。不要把凭证写入仓库。',
  );
  process.exit(1);
}

const prisma = new PrismaClient();
registerPlatformManagedNode(prisma, { name, host, port, username, password })
  .then((node) => {
    console.log(
      JSON.stringify({
        id: node.id,
        name: node.name,
        host: node.host,
        port: node.port,
        scope: node.scope,
        status: node.status,
        workspaceId: node.workspaceId,
      }),
    );
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : '登记失败');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
