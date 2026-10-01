/**
 * Resume existing CloudResource (no CreateDBInstance / no new CloudResource).
 * Polls until DONE or FAILED, then checks /db-check and Web.
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

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { Queue } = require(resolve(root, 'apps/worker/node_modules/bullmq'));
const {
  getRedisConnection,
  DATABASE_PROVISION_QUEUE,
  decryptCredential,
} = require(resolve(root, 'packages/shared/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const rdsPkg = requireP('@alicloud/rds20140815');
const openapi = requireP('@alicloud/openapi-core');

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
  return json;
}

const login = await api('/auth/login', {
  method: 'POST',
  body: {
    email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
    password: process.env.E2E_PASSWORD || 'Launchos123!',
  },
});
const token = login.accessToken;

const prisma = new PrismaClient();
const before = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
if (!before?.providerResourceId || before.providerResourceId !== KEEP_RDS) {
  throw new Error(`providerResourceId unexpected: ${before?.providerResourceId}`);
}

console.log(
  JSON.stringify(
    {
      before: {
        status: before.status,
        providerResourceId: before.providerResourceId,
      },
    },
    null,
    2,
  ),
);

const resumed = await api(`/projects/${PROJECT_ID}/database-provisions/${CR_ID}/retry`, {
  method: 'POST',
  token,
});
console.log(
  JSON.stringify(
    {
      resumed: {
        id: resumed.id,
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

const started = Date.now();
let finalStatus = resumed;
while (Date.now() - started < 20 * 60_000) {
  finalStatus = await api(`/projects/${PROJECT_ID}/database-provisions/${CR_ID}`, { token });
  console.log(
    `poll status=${finalStatus.status} raw=${finalStatus.statusRaw} phase=${finalStatus.phase} err=${finalStatus.errorMessage || ''}`,
  );
  if (finalStatus.statusRaw === 'RUNNING' || finalStatus.status === '可用') break;
  if (finalStatus.statusRaw === 'FAILED' || finalStatus.status === '创建失败') break;
  await new Promise((r) => setTimeout(r, 5000));
}

const after = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
const meta = after?.metadata && typeof after.metadata === 'object' ? after.metadata : {};
const conn = await prisma.databaseConnection.findFirst({
  where: { cloudResourceId: CR_ID },
  select: {
    id: true,
    status: true,
    host: true,
    port: true,
    databaseName: true,
    username: true,
    source: true,
  },
});

// Aliyun readonly snapshot
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

let dbCheck = null;
try {
  const res = await fetch('https://api-launchos.zsaos.com/db-check', {
    headers: { Accept: 'application/json' },
  });
  dbCheck = { status: res.status, body: await res.json().catch(() => null) };
} catch (err) {
  dbCheck = { error: String(err?.message || err).slice(0, 200) };
}

let web = null;
try {
  const res = await fetch('https://web-launchos.zsaos.com', { method: 'GET' });
  web = { status: res.status };
} catch (err) {
  web = { error: String(err?.message || err).slice(0, 200) };
}

const queue = new Queue(DATABASE_PROVISION_QUEUE, { connection: getRedisConnection() });
const job = await queue.getJob(`db-provision-${CR_ID}`);

console.log(
  JSON.stringify(
    {
      final: {
        status: after?.status,
        phase: meta.phase,
        providerResourceId: after?.providerResourceId,
        errorCode: meta.errorCode || null,
        errorMessage: meta.errorMessage || null,
        technicalMessage: meta.technicalMessage || null,
        createInstanceCompleted: meta.createInstanceCompleted === true,
      },
      aliyun: {
        databases: (dbs.body?.databases?.Database || dbs.body?.databases?.database || []).map(
          (d) => d.DBName || d.dbName,
        ),
        accounts: (accts.body?.accounts?.DBInstanceAccount ||
          accts.body?.accounts?.dBInstanceAccount ||
          []).map((a) => ({
          name: a.accountName || a.AccountName,
          status: a.accountStatus || a.AccountStatus,
        })),
      },
      databaseConnection: conn
        ? {
            id: conn.id,
            status: conn.status,
            hostMasked: conn.host ? `${String(conn.host).slice(0, 20)}***` : null,
            port: conn.port,
            databaseName: conn.databaseName,
            username: conn.username,
            source: conn.source,
          }
        : null,
      bullmq: {
        state: job ? await job.getState() : null,
        attemptsMade: job?.attemptsMade ?? null,
        failedReason: job?.failedReason
          ? String(job.failedReason).replace(/ClientToken=[^&\s]+/gi, 'ClientToken=[REDACTED]').slice(0, 300)
          : null,
      },
      dbCheck,
      web,
      createDbInstanceStillZero: after?.providerResourceId === KEEP_RDS,
    },
    null,
    2,
  ),
);

await queue.close();
await prisma.$disconnect();
process.exit(after?.status === 'RUNNING' && dbCheck?.body?.databaseConnected === true ? 0 : 2);
