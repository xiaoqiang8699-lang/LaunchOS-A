/**
 * Read-only diagnose CREATING_ACCOUNT failure for Step 25.3.
 * No Create/Delete/retry/mutate.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CR_ID = 'cmu4110xm0001ric027vr0tc3';
const KEEP_RDS = 'pgm-bp14j1lljy571v8h';

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
const {
  getRedisConnection,
  DATABASE_PROVISION_QUEUE,
  redactSecrets,
} = require(resolve(root, 'packages/shared/dist/index.js'));
const { Queue } = require(resolve(root, 'apps/worker/node_modules/bullmq'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const rdsPkg = requireP('@alicloud/rds20140815');
const openapi = requireP('@alicloud/openapi-core');

function asMeta(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function safe(text) {
  if (text == null) return null;
  return redactSecrets(String(text))
    .replace(/postgres:\/\/[^:\s]+:[^@\s]+@/gi, 'postgres://[REDACTED]@')
    .replace(/ClientToken=[^&\s]+/gi, 'ClientToken=[REDACTED]')
    .replace(/\b(LTAI[A-Za-z0-9]{8,})\b/g, '[REDACTED_AK]')
    .replace(/(password|Password|AccessKeySecret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 800);
}

function guessFailedApi(message, phase) {
  const m = String(message || '');
  const checks = [
    [/CreateDatabase|InvalidDBName|Database\..*AlreadyExist|rds:CreateDatabase/i, 'CreateDatabase', 'rds:CreateDatabase'],
    [/CreateAccount|InvalidAccountName|Account\..*AlreadyExist|rds:CreateAccount/i, 'CreateAccount', 'rds:CreateAccount'],
    [/GrantAccountPrivilege|rds:GrantAccountPrivilege/i, 'GrantAccountPrivilege', 'rds:GrantAccountPrivilege'],
    [/DescribeDatabases|rds:DescribeDatabases/i, 'DescribeDatabases', 'rds:DescribeDatabases'],
    [/DescribeAccounts|rds:DescribeAccounts/i, 'DescribeAccounts', 'rds:DescribeAccounts'],
    [/ModifySecurityIps|rds:ModifySecurityIps/i, 'ModifySecurityIps', 'rds:ModifySecurityIps'],
    [/DescribeDBInstanceNetInfo|rds:DescribeDBInstanceNetInfo/i, 'DescribeDBInstanceNetInfo', 'rds:DescribeDBInstanceNetInfo'],
    [/DescribeDBInstanceAttribute|rds:DescribeDBInstanceAttribute/i, 'DescribeDBInstanceAttribute', 'rds:DescribeDBInstanceAttribute'],
    [/CreateDBInstance|rds:CreateDBInstance/i, 'CreateDBInstance', 'rds:CreateDBInstance'],
    [/waitUntilRunning|DBInstanceStatus/i, 'waitUntilRunning/DescribeDBInstanceAttribute', 'rds:DescribeDBInstanceAttribute'],
  ];
  for (const [re, api, action] of checks) {
    if (re.test(m)) return { api, likelyMissingAction: action };
  }
  if (phase === 'CREATING_ACCOUNT') {
    return {
      api: 'unknown_within_CREATING_ACCOUNT_block',
      likelyMissingAction: null,
      note: 'phase is CREATING_ACCOUNT — candidates: CreateDatabase / CreateAccount / GrantAccountPrivilege (or prior setWhitelist if phase stamp lagged)',
    };
  }
  return { api: 'unknown', likelyMissingAction: null };
}

function extractProviderBits(message) {
  const m = String(message || '');
  const code =
    (m.match(/\bcode:\s*([A-Za-z0-9._-]+)/i) || [])[1] ||
    (m.match(/\bCode[=:]\s*([A-Za-z0-9._-]+)/i) || [])[1] ||
    (m.match(/\b([A-Za-z]+(?:\.[A-Za-z]+)+)\b/) || [])[1] ||
    null;
  const requestId =
    (m.match(/request id:\s*([A-F0-9-]+)/i) || [])[1] ||
    (m.match(/RequestId[=:]\s*([A-F0-9-]+)/i) || [])[1] ||
    null;
  const is403 = /Forbidden|not authorized|NoPermission|AccessDenied|code:\s*403/i.test(m);
  const isTimeout = /timeout|ConnectTimeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(m);
  return { providerErrorCode: code, requestId, is403, isTimeout };
}

const prisma = new PrismaClient();
const queue = new Queue(DATABASE_PROVISION_QUEUE, { connection: getRedisConnection() });

try {
  const resource = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  if (!resource) throw new Error('CloudResource missing');
  const meta = asMeta(resource.metadata);
  const job = await queue.getJob(`db-provision-${CR_ID}`);
  const jobState = job ? await job.getState() : null;

  const failedReason = safe(job?.failedReason);
  const tech = safe(meta.technicalMessage || meta.errorMessage);
  const combined = [failedReason, tech, meta.providerErrorCode, meta.errorCode]
    .filter(Boolean)
    .join('\n');

  const guess = guessFailedApi(combined, meta.phase);
  const bits = extractProviderBits(combined);

  // Read-only: current DB/account state on Aliyun (no mutate)
  let aliyunSnapshot = null;
  try {
    const account = await prisma.providerAccount.findFirst({
      where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
      orderBy: { createdAt: 'asc' },
    });
    const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
    const config = new openapi.$OpenApiUtil.Config({
      accessKeyId: secrets.accessKey,
      accessKeySecret: secrets.secretKey,
    });
    config.endpoint = 'rds.aliyuncs.com';
    const rds = new rdsPkg.default(config);

    const dbs = await rds.describeDatabases(
      new rdsPkg.DescribeDatabasesRequest({
        DBInstanceId: KEEP_RDS,
        pageSize: 100,
        pageNumber: 1,
      }),
    );
    const accts = await rds.describeAccounts(
      new rdsPkg.DescribeAccountsRequest({
        DBInstanceId: KEEP_RDS,
        pageSize: 100,
        pageNumber: 1,
      }),
    );
    aliyunSnapshot = {
      databases: (dbs.body?.databases?.Database || []).map((d) => d.DBName),
      accounts: (accts.body?.accounts?.DBInstanceAccount || []).map((a) => ({
        name: a.AccountName,
        type: a.AccountType,
        status: a.AccountStatus,
      })),
    };
  } catch (err) {
    aliyunSnapshot = { error: safe(err?.message || err) };
  }

  const phases = Array.isArray(meta.phases) ? meta.phases : [];
  const recentPhases = phases.slice(-12);

  // Did this attempt call CreateDBInstance? Look at failedReason URL / phase markers
  const createDbMentioned = /CreateDBInstance|Category=Basic&ClientToken=/i.test(
    String(job?.failedReason || ''),
  );
  const createMustBeZero =
    Boolean(resource.providerResourceId) &&
    meta.createInstanceCompleted === true &&
    !createDbMentioned;

  console.log(
    JSON.stringify(
      {
        cloudResource: {
          id: resource.id,
          status: resource.status,
          phase: meta.phase || null,
          providerResourceId: resource.providerResourceId,
          lastErrorCode: meta.errorCode || null,
          lastErrorMessage: safe(meta.errorMessage),
          technicalMessage: safe(meta.technicalMessage),
          providerErrorCode: meta.providerErrorCode || bits.providerErrorCode,
          providerRequestId: meta.providerRequestId || bits.requestId,
          failedAt: meta.failedAt || resource.updatedAt,
          createInstanceCompleted: meta.createInstanceCompleted === true,
          expectedDatabaseName: meta.databaseName || null,
          expectedUsername: meta.username || null,
        },
        bullmq: {
          jobId: `db-provision-${CR_ID}`,
          state: jobState,
          attemptsMade: job?.attemptsMade ?? null,
          processedOn: job?.processedOn ? new Date(job.processedOn).toISOString() : null,
          finishedOn: job?.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          failedReason,
        },
        recentPhases,
        diagnosis: {
          guessedFailedApi: guess.api,
          likelyMissingRamAction: guess.likelyMissingAction,
          note: guess.note || null,
          is403Permission: bits.is403,
          isTimeout: bits.isTimeout,
          providerErrorCode: bits.providerErrorCode || meta.providerErrorCode || null,
          requestId: bits.requestId || meta.providerRequestId || null,
        },
        aliyunReadonlySnapshot: aliyunSnapshot,
        createDbInstanceCallsThisAttemptLikelyZero: createMustBeZero,
        createDbInstanceMentionedInFailedReason: createDbMentioned,
      },
      null,
      2,
    ),
  );
} finally {
  await queue.close();
  await prisma.$disconnect();
}
