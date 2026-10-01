/**
 * Read-only backfill of provider error fields from existing technicalMessage.
 * Does NOT CreateInstance / resume / delete.
 */
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
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const CR = process.argv[2] || 'cmu4xn1j60001riaw6gjh0rfn';
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const {
  classifyCloudRedisError,
  parseAliyunRedisProviderError,
  cloudRedisErrorUserMessage,
} = require(resolve(root, 'packages/shared/dist/index.js'));

const prisma = new PrismaClient();
const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
if (!cr) {
  console.error('CloudResource not found');
  process.exit(1);
}
const meta = cr.metadata && typeof cr.metadata === 'object' ? cr.metadata : {};
const tech = String(meta.technicalMessage || '');
const classified = classifyCloudRedisError(new Error(tech));
const parsed = parseAliyunRedisProviderError(new Error(tech));
const userMsg = cloudRedisErrorUserMessage(classified.code, tech);

await prisma.cloudResource.update({
  where: { id: CR },
  data: {
    metadata: {
      ...meta,
      errorCode: classified.code,
      errorMessage: userMsg,
      providerErrorCode: parsed.providerErrorCode,
      providerErrorMessage: parsed.providerErrorMessage,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
      failedOperation: 'CreateInstance',
      retryableAfterUserAction: Boolean(classified.retryableAfterUserAction),
    },
  },
});

const after = await prisma.cloudResource.findUnique({ where: { id: CR } });
const m = after.metadata || {};
console.log(
  JSON.stringify(
    {
      cloudResourceId: CR,
      status: after.status,
      providerResourceId: after.providerResourceId,
      createInstanceAttemptCount: m.createInstanceAttemptCount ?? 0,
      createInstanceSuccessCount: m.createInstanceSuccessCount ?? 0,
      errorCode: m.errorCode,
      errorMessage: m.errorMessage,
      providerErrorCode: m.providerErrorCode,
      providerErrorMessage: m.providerErrorMessage,
      providerRequestId: m.providerRequestId,
      httpStatus: m.httpStatus,
      failedOperation: m.failedOperation,
      retryableAfterUserAction: m.retryableAfterUserAction,
      technicalMessage: m.technicalMessage,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
