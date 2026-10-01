/**
 * One-shot safe reconcile for Step 25.3.
 * Binds CloudResource to existing RDS. Does NOT Create/Delete/retry/start worker.
 *
 *   node scripts/step-253-rds-reconcile-bind.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const CLOUD_RESOURCE_ID = 'cmu4110xm0001ric027vr0tc3';
const KEEP_RDS_ID = 'pgm-bp14j1lljy571v8h';
const ORPHAN_RDS_ID = 'pgm-bp189242upo9udy4';
const EXPECTED_OPERATION_ID = 'op_94dd2603ced1b625';

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

const { PrismaClient, CloudResourceStatus } = require(
  resolve(root, 'packages/database/generated/client'),
);
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const rdsPkg = requireP('@alicloud/rds20140815');
const openapi = requireP('@alicloud/openapi-core');

const prisma = new PrismaClient();
let createDbInstanceCalls = 0;

function asMeta(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function pushUniqueHistory(history, entry) {
  const key = `${entry.code || ''}|${entry.message || ''}`;
  if (history.some((h) => `${h.code || ''}|${h.message || ''}` === key)) {
    return history;
  }
  history.push(entry);
  return history;
}

try {
  const before = await prisma.cloudResource.findUnique({
    where: { id: CLOUD_RESOURCE_ID },
  });
  if (!before) {
    throw new Error(`CloudResource not found: ${CLOUD_RESOURCE_ID}`);
  }

  const meta = asMeta(before.metadata);
  const operationId =
    typeof meta.operationId === 'string' && meta.operationId.trim()
      ? meta.operationId.trim()
      : EXPECTED_OPERATION_ID;

  if (operationId !== EXPECTED_OPERATION_ID) {
    throw new Error(
      `operationId mismatch: got ${operationId}, expected ${EXPECTED_OPERATION_ID}`,
    );
  }

  // Read-only verify target RDS exists (Describe only — never Create).
  const account = await prisma.providerAccount.findFirst({
    where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
    orderBy: { createdAt: 'asc' },
  });
  if (!account?.credentialEncrypted) {
    throw new Error('ALIYUN ProviderAccount missing');
  }
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const config = new openapi.$OpenApiUtil.Config({
    accessKeyId: secrets.accessKey,
    accessKeySecret: secrets.secretKey,
  });
  config.endpoint = 'rds.aliyuncs.com';
  const rds = new rdsPkg.default(config);

  const describe = await rds.describeDBInstances(
    new rdsPkg.DescribeDBInstancesRequest({
      regionId: before.region || meta.region || 'cn-hangzhou',
      engine: 'PostgreSQL',
      DBInstanceId: KEEP_RDS_ID,
      pageSize: 10,
      pageNumber: 1,
    }),
  );
  const hit = (describe.body?.items?.DBInstance || []).find(
    (x) => x.DBInstanceId === KEEP_RDS_ID,
  );
  if (!hit) {
    throw new Error(`Target RDS not found via DescribeDBInstances: ${KEEP_RDS_ID}`);
  }

  const now = new Date().toISOString();
  const phases = Array.isArray(meta.phases) ? [...meta.phases] : [];
  phases.push({
    phase: 'PREPARING_NETWORK',
    at: now,
    status: 'running',
    note: 'manual_reconcile_bind',
  });

  let errorHistory = Array.isArray(meta.errorHistory) ? [...meta.errorHistory] : [];
  const known = [
    {
      code: 'ServiceLinkedRole.NotExist',
      source: 'provider',
      retainedAt: now,
    },
    {
      code: 'InvalidConcurrentOperate',
      source: 'provider',
      retainedAt: now,
    },
    {
      code: 'PROVIDER_TIMEOUT',
      source: 'launchos',
      message: typeof meta.errorMessage === 'string' ? meta.errorMessage : undefined,
      retainedAt: now,
    },
  ];
  for (const item of known) {
    errorHistory = pushUniqueHistory(errorHistory, item);
  }
  if (meta.errorCode || meta.providerErrorCode || meta.errorMessage) {
    errorHistory = pushUniqueHistory(errorHistory, {
      code: meta.errorCode || meta.providerErrorCode || 'UNKNOWN',
      providerErrorCode: meta.providerErrorCode || null,
      message: meta.errorMessage || null,
      providerRequestId: meta.providerRequestId || null,
      retainedAt: now,
      from: 'pre_reconcile_snapshot',
    });
  }

  const updated = await prisma.cloudResource.update({
    where: { id: CLOUD_RESOURCE_ID },
    data: {
      providerResourceId: KEEP_RDS_ID,
      externalId: KEEP_RDS_ID,
      status: CloudResourceStatus.CREATING,
      metadata: {
        ...meta,
        operationId,
        clientToken: operationId.slice(0, 64),
        phase: 'PREPARING_NETWORK',
        phases,
        createInstanceCompleted: true,
        reconciledFromProvider: true,
        reconciledAt: now,
        reconciledProviderResourceId: KEEP_RDS_ID,
        orphanCandidateId: ORPHAN_RDS_ID,
        orphanDeleteDeferred: true,
        // keep latest error snapshot for audit; clear active failure flags for resume UI
        lastFailedErrorCode: meta.errorCode || meta.providerErrorCode || null,
        lastFailedErrorMessage: meta.errorMessage || null,
        errorHistory,
        errorCode: null,
        errorMessage: null,
        technicalMessage: null,
        providerErrorCode: null,
        providerRequestId: null,
        // do not enqueue / do not mark retrying
        retryingAt: null,
      },
    },
  });

  const afterMeta = asMeta(updated.metadata);
  console.log(
    JSON.stringify(
      {
        createDbInstanceCalls,
        describeOnly: {
          dbInstanceId: KEEP_RDS_ID,
          status: hit.DBInstanceStatus || null,
          description: hit.DBInstanceDescription || null,
        },
        cloudResource: {
          id: updated.id,
          providerResourceId: updated.providerResourceId,
          externalId: updated.externalId,
          status: updated.status,
          phase: afterMeta.phase || null,
          operationId: afterMeta.operationId || null,
          clientToken: afterMeta.clientToken || null,
          createInstanceCompleted: afterMeta.createInstanceCompleted === true,
          reconciledFromProvider: afterMeta.reconciledFromProvider === true,
          orphanCandidateId: afterMeta.orphanCandidateId || null,
        },
      },
      null,
      2,
    ),
  );

  if (updated.providerResourceId !== KEEP_RDS_ID) {
    throw new Error('providerResourceId bind failed');
  }
  if (createDbInstanceCalls !== 0) {
    throw new Error('CreateDBInstance was invoked — abort');
  }
} finally {
  await prisma.$disconnect();
}
