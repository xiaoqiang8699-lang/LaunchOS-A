/**
 * Full resume + redeploy + verify for Step 25.3 (no CreateDBInstance).
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
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = 'cmu3j24mv0001ri7wcsoa30hj';
const CR_ID = 'cmu4110xm0001ric027vr0tc3';
const KEEP_RDS = 'pgm-bp14j1lljy571v8h';
const API_UNIT = 'cmu3j272x0005ri7wlxlbajeu';
const WEB_UNIT = 'cmu3j27340007ri7wcno1xrai';
const ENV_ID = process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { Queue } = require(resolve(root, 'apps/worker/node_modules/bullmq'));
const {
  getRedisConnection,
  DATABASE_PROVISION_QUEUE,
  decryptCredential,
  redactSecrets,
} = require(resolve(root, 'packages/shared/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const rdsPkg = requireP('@alicloud/rds20140815');
const openapi = requireP('@alicloud/openapi-core');

function safe(text) {
  return redactSecrets(String(text || ''))
    .replace(/postgres:\/\/[^:\s]+:[^@\s]+@/gi, 'postgres://[REDACTED]@')
    .slice(0, 500);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(
      Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText,
    );
  }
  const blob = JSON.stringify(json);
  if (/accessKeySecret|secretKey|passwordEncrypted|postgres:\/\/[^:]+:[^@]+@/i.test(blob)) {
    throw new Error('possible secret leak in API response');
  }
  return json;
}

const prisma = new PrismaClient();
const login = await api('/auth/login', {
  method: 'POST',
  body: {
    email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
    password: process.env.E2E_PASSWORD || 'Launchos123!',
  },
});
const token = login.accessToken;

// 1) unlock check
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
const attr = await rds.describeDBInstanceAttribute(
  new rdsPkg.DescribeDBInstanceAttributeRequest({ DBInstanceId: KEEP_RDS }),
);
const a = attr.body?.items?.DBInstanceAttribute?.[0] || {};
const lockMode = a.lockMode || a.LockMode || 'Unlock';
const status = a.DBInstanceStatus || a.dBInstanceStatus;
console.log(JSON.stringify({ unlockCheck: { status, lockMode } }, null, 2));
if (String(lockMode).toLowerCase() !== 'unlock' && String(lockMode) !== '' && String(lockMode) !== 'null') {
  if (/lock/i.test(String(lockMode)) && !/^unlock$/i.test(String(lockMode))) {
    console.log('STOP: still locked');
    process.exit(2);
  }
}

const beforeCr = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
if (beforeCr?.providerResourceId !== KEEP_RDS) {
  throw new Error(`providerResourceId mismatch: ${beforeCr?.providerResourceId}`);
}

const webBefore = await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, {
  token,
});
const apiBefore = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, {
  token,
});
const webRevBefore = webBefore.summary?.configRevision ?? 0;
const apiRevBefore = apiBefore.summary?.configRevision ?? 0;

const resumed = await api(`/projects/${PROJECT_ID}/database-provisions/${CR_ID}/retry`, {
  method: 'POST',
  token,
});
console.log(
  JSON.stringify(
    {
      resumed: {
        status: resumed.status,
        statusRaw: resumed.statusRaw,
        phase: resumed.phase,
        providerResourceId: resumed.providerResourceId,
      },
    },
    null,
    2,
  ),
);

let finalStatus = resumed;
const started = Date.now();
while (Date.now() - started < 20 * 60_000) {
  finalStatus = await api(`/projects/${PROJECT_ID}/database-provisions/${CR_ID}`, { token });
  console.log(
    `poll status=${finalStatus.status} raw=${finalStatus.statusRaw} phase=${finalStatus.phase} err=${finalStatus.errorMessage || ''}`,
  );
  if (finalStatus.statusRaw === 'RUNNING' || finalStatus.status === '可用') break;
  if (finalStatus.statusRaw === 'FAILED' || finalStatus.status === '创建失败') break;
  await new Promise((r) => setTimeout(r, 5000));
}

const afterCr = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
const meta = afterCr?.metadata && typeof afterCr.metadata === 'object' ? afterCr.metadata : {};
if (afterCr?.status !== 'RUNNING') {
  console.log(
    JSON.stringify(
      {
        failed: true,
        status: afterCr?.status,
        phase: meta.phase,
        errorCode: meta.errorCode,
        technicalMessage: safe(meta.technicalMessage),
      },
      null,
      2,
    ),
  );
  process.exit(2);
}

const conn = await prisma.databaseConnection.findFirst({
  where: { cloudResourceId: CR_ID },
});
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
const dbNames = (dbs.body?.databases?.database || dbs.body?.databases?.Database || []).map(
  (d) => d.DBName || d.dbName,
);
const accountNames = (
  accts.body?.accounts?.dBInstanceAccount ||
  accts.body?.accounts?.DBInstanceAccount ||
  []
).map((x) => x.accountName || x.AccountName);

const apiAfterBind = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, {
  token,
});
const webAfterBind = await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, {
  token,
});
const apiRevAfterBind = apiAfterBind.summary?.configRevision ?? 0;
const webRevAfterBind = webAfterBind.summary?.configRevision ?? 0;
const dbReq = (apiAfterBind.requirements || []).find((r) => r.key === 'DATABASE_URL');

// Redeploy API via normal API → BullMQ path
const deployment = await api(`/projects/${PROJECT_ID}/deployments`, {
  method: 'POST',
  token,
  body: {
    environmentId: ENV_ID,
    deployableUnitId: API_UNIT,
  },
});
console.log(JSON.stringify({ deploymentId: deployment.id, status: deployment.status }, null, 2));

let depFinal = deployment;
const depStarted = Date.now();
while (Date.now() - depStarted < 10 * 60_000) {
  depFinal = await api(`/deployments/${deployment.id}`, { token });
  console.log(`deploy status=${depFinal.status}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(depFinal.status)) break;
  await new Promise((r) => setTimeout(r, 5000));
}

const service = await prisma.serviceInstance.findFirst({
  where: { projectId: PROJECT_ID, deployableUnitId: API_UNIT },
  orderBy: { updatedAt: 'desc' },
  select: {
    id: true,
    status: true,
    healthStatus: true,
    containerId: true,
    updatedAt: true,
  },
});

let dbCheck = null;
for (let i = 0; i < 12; i++) {
  try {
    const res = await fetch('https://api-launchos.zsaos.com/db-check', {
      headers: { Accept: 'application/json' },
    });
    dbCheck = { status: res.status, body: await res.json().catch(() => null) };
    if (res.status === 200 && dbCheck.body?.databaseConnected === true) break;
  } catch (err) {
    dbCheck = { error: String(err?.message || err).slice(0, 200) };
  }
  await new Promise((r) => setTimeout(r, 5000));
}

let web = null;
try {
  const res = await fetch('https://web-launchos.zsaos.com');
  web = { status: res.status };
} catch (err) {
  web = { error: String(err?.message || err).slice(0, 200) };
}

const rdsList = await rds.describeDBInstances(
  new rdsPkg.DescribeDBInstancesRequest({
    regionId: 'cn-hangzhou',
    engine: 'PostgreSQL',
    pageSize: 30,
  }),
);
const instances = (rdsList.body?.items?.DBInstance || []).map((i) => ({
  id: i.DBInstanceId,
  status: i.DBInstanceStatus,
  desc: i.DBInstanceDescription,
}));

const allDbCr = await prisma.cloudResource.findMany({
  where: { type: 'DATABASE', projectId: PROJECT_ID },
  select: { id: true, providerResourceId: true, status: true },
});

const queue = new Queue(DATABASE_PROVISION_QUEUE, { connection: getRedisConnection() });
const job = await queue.getJob(`db-provision-${CR_ID}`);
const failedReason = job?.failedReason ? safe(job.failedReason) : null;
const createMentioned = /CreateDBInstance/i.test(String(job?.failedReason || ''));

console.log(
  JSON.stringify(
    {
      unlock: { status, lockMode },
      provision: {
        status: afterCr.status,
        phase: meta.phase,
        providerResourceId: afterCr.providerResourceId,
        networkMode: meta.networkMode || null,
        connectionHostMasked: meta.connectionHost
          ? `${String(meta.connectionHost).slice(0, 28)}***`
          : null,
        connectionPort: meta.connectionPort || null,
      },
      aliyun: { databases: dbNames, accounts: accountNames, instances },
      databaseConnection: conn
        ? {
            id: conn.id,
            status: conn.status,
            source: conn.source,
            cloudResourceId: conn.cloudResourceId,
            hostMasked: conn.host ? `${String(conn.host).slice(0, 28)}***` : null,
            port: conn.port,
            databaseName: conn.databaseName,
            username: conn.username,
          }
        : null,
      revisions: {
        apiBefore: apiRevBefore,
        apiAfterBind: apiRevAfterBind,
        webBefore: webRevBefore,
        webAfterBind: webRevAfterBind,
        databaseUrlConfigured: dbReq?.configured === true,
        databaseUrlProvider: dbReq?.provider || null,
      },
      deployment: {
        id: depFinal.id,
        status: depFinal.status,
      },
      serviceInstance: service,
      dbCheck,
      web,
      uniqueness: {
        cloudResources: allDbCr,
        rdsCount: instances.length,
        onlyKeepId: instances.length === 1 && instances[0]?.id === KEEP_RDS,
      },
      createDbInstanceCallsZero: afterCr.providerResourceId === KEEP_RDS && !createMentioned,
      bullmq: {
        state: job ? await job.getState() : null,
        attemptsMade: job?.attemptsMade ?? null,
        failedReason,
      },
    },
    null,
    2,
  ),
);

await queue.close();
await prisma.$disconnect();

const ok =
  afterCr.status === 'RUNNING' &&
  Boolean(conn?.id) &&
  apiRevAfterBind > apiRevBefore &&
  webRevAfterBind === webRevBefore &&
  depFinal.status === 'SUCCESS' &&
  dbCheck?.status === 200 &&
  dbCheck?.body?.databaseConnected === true &&
  web?.status === 200 &&
  instances.length === 1;
process.exit(ok ? 0 : 2);
