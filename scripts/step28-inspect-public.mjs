import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, 'apps/api/.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue; const i = t.indexOf('='); if (i <= 0) continue;
    const k = t.slice(0, i).trim(); let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
const require = createRequire(resolve(root, 'packages/database/package.json'));
const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();
const projectId = 'cmumcbqn3001jriq8am7vxtf6';
const domains = await prisma.applicationDomain.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 10 });
const env = await prisma.projectEnvironment.findFirst({ where: { projectId, name: 'production' } });
const deps = await prisma.deployment.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, status: true, releaseLabel: true, sourceRevision: true, failureCode: true, currentStage: true, createdAt: true } });
const routes = await prisma.gatewayRoute.findMany({ where: { hostname: { contains: 'launchos-real-test' } }, take: 10 }).catch(() => []);
console.log(JSON.stringify({ domains, env: { active: env?.activeDeploymentId, prev: env?.previousDeploymentId }, deps, routes }, null, 2));
await prisma.$disconnect();
