/**
 * Read-only dump of latest CreateInstance failure fields. No Create.
 */
import { createRequire } from 'node:module';
import { readFileSync, statSync, existsSync } from 'node:fs';
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
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const CR = process.argv[2] || 'cmu4xn1j60001riaw6gjh0rfn';
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const {
  parseAliyunRedisProviderError,
  classifyCloudRedisError,
  cloudRedisErrorUserMessage,
} = require(resolve(root, 'packages/shared/dist/index.js'));

const prisma = new PrismaClient();
const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
const m = cr?.metadata && typeof cr.metadata === 'object' ? cr.metadata : {};
const tech = String(m.technicalMessage || '');
const parsed = parseAliyunRedisProviderError(new Error(tech));
const classified = classifyCloudRedisError(new Error(tech));

const paths = [
  'packages/shared/dist/redis-provision.js',
  'apps/worker/dist/redis-provision-executor.js',
  'apps/api/dist/redis-provision/redis-provision.service.js',
];
const buildInfo = {};
for (const p of paths) {
  const abs = resolve(root, p);
  buildInfo[p] = existsSync(abs)
    ? {
        mtime: statSync(abs).mtime.toISOString(),
        hasBilling: readFileSync(abs, 'utf8').includes('REDIS_BILLING_INSUFFICIENT_BALANCE'),
        hasOrderButGuard: readFileSync(abs, 'utf8').includes('order.but') || readFileSync(abs, 'utf8').includes('.but'),
      }
    : null;
}

console.log(
  JSON.stringify(
    {
      cloudResourceId: CR,
      status: cr?.status,
      providerResourceId: cr?.providerResourceId ?? null,
      updatedAt: cr?.updatedAt,
      persisted: {
        errorCode: m.errorCode ?? null,
        errorMessage: m.errorMessage ?? null,
        technicalMessage: m.technicalMessage ?? null,
        providerErrorCode: m.providerErrorCode ?? null,
        providerErrorMessage: m.providerErrorMessage ?? null,
        providerRequestId: m.providerRequestId ?? null,
        httpStatus: m.httpStatus ?? null,
        failedOperation: m.failedOperation ?? null,
        failedAt: m.failedAt ?? null,
        retryableAfterUserAction: m.retryableAfterUserAction ?? null,
        createInstanceAttemptCount: m.createInstanceAttemptCount ?? 0,
        createInstanceSuccessCount: m.createInstanceSuccessCount ?? 0,
        createInstanceCallCount: m.createInstanceCallCount ?? 0,
        lastPhase: (m.phases || []).slice(-1)[0] || null,
        errorHistoryTail: (m.errorHistory || []).slice(-3),
      },
      derivedFromTechnical: {
        parsed,
        classified,
        userMessage: cloudRedisErrorUserMessage(classified.code, tech),
      },
      buildInfo,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
