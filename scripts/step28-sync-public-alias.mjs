/**
 * One-shot: point launchos-real-test.zsaos.com at the current healthy runtime port.
 * Does not print secrets.
 */
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

const require = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = require('@launchos/database');
const { decryptCredential } = require('@launchos/shared');
const { applyColocatedNginxRoute } = require('@launchos/domain');

const prisma = new PrismaClient();
const projectId = 'cmumcbqn3001jriq8am7vxtf6';
const publicHost = 'launchos-real-test.zsaos.com';

const domain = await prisma.applicationDomain.findFirst({
  where: { projectId, type: 'SYSTEM' },
  orderBy: { updatedAt: 'desc' },
});
const service = await prisma.serviceInstance.findFirst({
  where: { projectId, status: 'RUNNING' },
  orderBy: { updatedAt: 'desc' },
  include: { server: true },
});
if (!domain || !service?.server) {
  throw new Error('missing domain or running service');
}
const port = domain.runtimePort || service.externalPort || service.port;
const password = decryptCredential(service.server.credentialEncrypted);
for (const hostname of [domain.domain, publicHost]) {
  const applied = await applyColocatedNginxRoute({
    host: service.server.host,
    port: service.server.port,
    username: service.server.username,
    password,
    hostname,
    targetPort: port,
    healthPath: '/',
  });
  console.log(JSON.stringify({ hostname, targetPort: port, reloaded: applied.reloaded }));
}
await prisma.applicationDomain.upsert({
  where: { domain: publicHost },
  create: {
    projectId,
    deployableUnitId: domain.deployableUnitId,
    domain: publicHost,
    type: 'CUSTOM',
    status: 'ACTIVE',
    dnsStatus: 'ACTIVE',
    sslStatus: 'ACTIVE',
    runtimeHost: '127.0.0.1',
    runtimePort: port,
  },
  update: {
    status: 'ACTIVE',
    runtimeHost: '127.0.0.1',
    runtimePort: port,
    deployableUnitId: domain.deployableUnitId,
  },
});
await prisma.$disconnect();
