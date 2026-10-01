import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { redactSecrets } = require(resolve(root, 'packages/shared/dist/index.js'));
const prisma = new PrismaClient();
const id = process.argv[2] || 'cmu46ooye000jriioo56k157q';
const d = await prisma.deployment.findUnique({ where: { id } });
console.log(
  JSON.stringify(
    {
      status: d?.status,
      errorMessage: redactSecrets(String(d?.errorMessage || '')).slice(0, 800),
      metaKeys: d?.metadata && typeof d.metadata === 'object' ? Object.keys(d.metadata) : [],
      metadata: d?.metadata
        ? JSON.parse(
            redactSecrets(JSON.stringify(d.metadata))
              .replace(/postgres:\/\/[^"]+/gi, 'postgres://[REDACTED]')
              .slice(0, 2000),
          )
        : null,
    },
    null,
    2,
  ),
);
const logs = await prisma.deploymentLog.findMany({
  where: { deploymentId: id },
  orderBy: { createdAt: 'asc' },
  take: 40,
});
for (const l of logs) {
  console.log(
    l.level,
    l.createdAt.toISOString(),
    redactSecrets(String(l.message || '')).slice(0, 300),
  );
}
await prisma.$disconnect();
