import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const prisma = new PrismaClient();
const API = 'cmu3j272x0005ri7wlxlbajeu';
const WEB = 'cmu3j27340007ri7wcno1xrai';
const PROJECT = 'cmu3j24mv0001ri7wcsoa30hj';

const webSvc = await prisma.serviceInstance.findFirst({
  where: { projectId: PROJECT, deployableUnitId: WEB, status: 'RUNNING' },
  orderBy: { updatedAt: 'desc' },
});
const apiSvc = await prisma.serviceInstance.findFirst({
  where: { projectId: PROJECT, deployableUnitId: API },
  orderBy: { updatedAt: 'desc' },
});
const webAv = await prisma.applicationVersion.findFirst({
  where: { deployableUnitId: WEB },
  orderBy: { createdAt: 'desc' },
});
const apiAv = await prisma.applicationVersion.findFirst({
  where: { deployableUnitId: API },
  orderBy: { createdAt: 'desc' },
});
const apiDep = await prisma.deployment.findFirst({
  where: { deployableUnitId: API },
  orderBy: { createdAt: 'desc' },
});
const webDep = await prisma.deployment.findFirst({
  where: { deployableUnitId: WEB },
  orderBy: { createdAt: 'desc' },
});
const units = await prisma.deployableUnit.findMany({
  where: { id: { in: [API, WEB] } },
  select: { id: true, name: true, configRevision: true },
});

console.log(
  JSON.stringify(
    {
      units,
      webSvc: webSvc && {
        id: webSvc.id,
        containerId: webSvc.containerId,
        status: webSvc.status,
        health: webSvc.healthStatus,
        updatedAt: webSvc.updatedAt,
      },
      apiSvc: apiSvc && {
        id: apiSvc.id,
        containerId: apiSvc.containerId,
        status: apiSvc.status,
        health: apiSvc.healthStatus,
        serverInstanceId: apiSvc.serverInstanceId,
        updatedAt: apiSvc.updatedAt,
      },
      webAv: webAv && {
        id: webAv.id,
        configRevision: webAv.configRevision,
        createdAt: webAv.createdAt,
      },
      apiAv: apiAv && {
        id: apiAv.id,
        configRevision: apiAv.configRevision,
        createdAt: apiAv.createdAt,
      },
      apiDep: apiDep && {
        id: apiDep.id,
        status: apiDep.status,
        configRevision: apiDep.configRevision,
        createdAt: apiDep.createdAt,
      },
      webDep: webDep && {
        id: webDep.id,
        status: webDep.status,
        configRevision: webDep.configRevision,
        createdAt: webDep.createdAt,
      },
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
