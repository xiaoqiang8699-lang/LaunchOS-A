import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, 'apps/api/.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const require = createRequire(resolve(root, 'packages/database/package.json'));
const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();

const projectId = 'cmumcbqn3001jriq8am7vxtf6';
const appDomains = await prisma.applicationDomain.findMany({
  where: { projectId },
  orderBy: { updatedAt: 'desc' },
});
const services = await prisma.serviceInstance.findMany({
  where: { projectId },
  orderBy: { createdAt: 'desc' },
  take: 10,
  select: {
    id: true,
    status: true,
    externalPort: true,
    port: true,
    internalPort: true,
    containerId: true,
    healthStatus: true,
    createdAt: true,
    updatedAt: true,
    artifact: { select: { deploymentId: true, storagePath: true } },
  },
});

const tables = await prisma.$queryRawUnsafe(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ILIKE '%gateway%' OR table_name ILIKE '%route%' OR table_name ILIKE '%nginx%' OR table_name ILIKE '%alias%') ORDER BY table_name`,
);

console.log(JSON.stringify({ appDomains, services, tables }, null, 2));
await prisma.$disconnect();
