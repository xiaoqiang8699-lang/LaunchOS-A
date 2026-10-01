import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const { PrismaClient } = createRequire(resolve(root, 'apps/api/package.json'))('@launchos/database');
const prisma = new PrismaClient();

const failed = await prisma.deployment.findMany({
  where: { id: { in: ['cmuc3rucy000jri6gbnhqf96x', 'cmuc53f9f000jriqg7r4kqhm6'] } },
  select: { id: true, status: true, projectId: true },
});
const run = await prisma.launchRun.findUnique({
  where: { id: 'lr_p4a_d025b18fa6bc' },
  select: { id: true, status: true, projectId: true, failureCode: true },
});
const test = await prisma.project.findUnique({
  where: { id: 'cmucerx5e0001ri4w0x6sx5cz' },
  select: { id: true, name: true, description: true, isDemo: true },
});
const apiSi = await prisma.serviceInstance.findUnique({
  where: { id: 'cmuc66642002hritk6h3cbwhe' },
  select: { status: true, healthStatus: true, externalPort: true },
});
const webSi = await prisma.serviceInstance.findUnique({
  where: { id: 'cmucaxah704r9ritkb30z16uw' },
  select: { status: true, healthStatus: true, externalPort: true },
});
const cert = await prisma.systemDomainConfig.findFirst({
  orderBy: { createdAt: 'asc' },
  select: { tlsCertificateDomain: true, tlsExpiresAt: true },
});
const oneclickSi = await prisma.serviceInstance.findUnique({
  where: { id: 'cmudi7z3t1autritkew7edk6c' },
  select: { status: true, healthStatus: true, externalPort: true },
});
console.log(
  JSON.stringify(
    { failed, run, test, apiSi, webSi, oneclickSi, cert },
    null,
    2,
  ),
);
await prisma.$disconnect();
