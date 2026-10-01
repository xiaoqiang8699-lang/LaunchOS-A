import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'apps/api/package.json'));
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

const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();
const r = await prisma.cloudResource.findUnique({ where: { id: 'cmuas8iiz0001riown1l1a0o3' } });
const meta = r?.metadata && typeof r.metadata === 'object' ? r.metadata : {};
console.log(
  JSON.stringify(
    {
      id: r?.id,
      status: r?.status,
      providerResourceId: r?.providerResourceId,
      region: r?.region,
      phase: meta.phase,
      phases: meta.phases,
      runInstancesAttemptCount: meta.runInstancesAttemptCount,
      runInstancesSuccessCount: meta.runInstancesSuccessCount,
      createGeneration: meta.createGeneration,
      lastErrorCode: meta.lastErrorCode,
      providerErrorCode: meta.providerErrorCode,
      lastErrorMessage: meta.lastErrorMessage,
      lastErrorUserMessage: meta.lastErrorUserMessage,
      lastRequestId: meta.lastRequestId,
      failedOperation: meta.failedOperation,
      createFailureKind: meta.createFailureKind,
      vpcId: meta.vpcId,
      vSwitchId: meta.vSwitchId,
      securityGroupId: meta.securityGroupId,
      loginMode: meta.loginMode,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
