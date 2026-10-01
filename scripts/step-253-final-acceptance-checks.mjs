/**
 * Final Step 25.3 acceptance checks (read-mostly, no CreateDBInstance).
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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

const CR_ID = 'cmu4110xm0001ric027vr0tc3';
const KEEP_RDS = 'pgm-bp14j1lljy571v8h';
const API_UNIT = 'cmu3j272x0005ri7wlxlbajeu';
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const rdsPkg = requireP('@alicloud/rds20140815');
const openapi = requireP('@alicloud/openapi-core');

const prisma = new PrismaClient();
const cr = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
const meta = cr.metadata || {};
const password = decryptCredential(meta.passwordEncrypted);
const conn = await prisma.databaseConnection.findFirst({ where: { cloudResourceId: CR_ID } });
const dbUrlValue = await prisma.runtimeConfigValue.findFirst({
  where: { deployableUnitId: API_UNIT, key: 'DATABASE_URL' },
});
const databaseUrl = dbUrlValue?.valueEncrypted
  ? decryptCredential(dbUrlValue.valueEncrypted)
  : '';

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

const list = await rds.describeDBInstances(
  new rdsPkg.DescribeDBInstancesRequest({
    regionId: 'cn-hangzhou',
    engine: 'PostgreSQL',
    pageSize: 30,
  }),
);
const instances = list.body?.items?.DBInstance || [];
const ips = await rds.describeDBInstanceIPArrayList(
  new rdsPkg.DescribeDBInstanceIPArrayListRequest({ DBInstanceId: KEEP_RDS }),
);
const arrays = (ips.body?.items?.DBInstanceIPArray || []).map((x) => ({
  name: x.DBInstanceIPArrayName || x.dBInstanceIPArrayName,
  attr: x.DBInstanceIPArrayAttribute || x.dBInstanceIPArrayAttribute || null,
  ips: String(x.securityIPList || x.SecurityIPList || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
}));
const hasOpenWorld = arrays.some((a) => a.ips.includes('0.0.0.0/0') || a.ips.includes('::/0'));
const launchosIps = arrays.find((a) => a.name === 'launchos')?.ips || [];

const accts = await rds.describeAccounts(
  new rdsPkg.DescribeAccountsRequest({ DBInstanceId: KEEP_RDS, pageSize: 100, pageNumber: 1 }),
);
const acct = (accts.body?.accounts?.dBInstanceAccount ||
  accts.body?.accounts?.DBInstanceAccount ||
  [])[0];
const privs =
  acct?.databasePrivileges?.DatabasePrivilege ||
  acct?.databasePrivileges?.databasePrivilege ||
  [];

// secret plaintext scan across recent deployment logs for this project
const deps = await prisma.deployment.findMany({
  where: { projectId: cr.projectId },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { id: true },
});
const logs = await prisma.deploymentLog.findMany({
  where: { deploymentId: { in: deps.map((d) => d.id) } },
  select: { message: true },
  take: 500,
});
const hay = logs.map((l) => String(l.message || '')).join('\n');
const hits = {
  passwordPlaintext: password && hay.includes(password) ? 1 : 0,
  databaseUrlPlaintext: databaseUrl && hay.includes(databaseUrl) ? 1 : 0,
  accessKeyPlaintext: secrets.accessKey && hay.includes(secrets.accessKey) ? 1 : 0,
  secretKeyPlaintext: secrets.secretKey && hay.includes(secrets.secretKey) ? 1 : 0,
};

// API response leak check
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const login = await fetch(`${API_BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
    password: process.env.E2E_PASSWORD || 'Launchos123!',
  }),
}).then((r) => r.json());
const token = login.accessToken;
const provision = await fetch(
  `${API_BASE}/projects/${cr.projectId}/database-provisions/${CR_ID}`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
).then((r) => r.json());
const connections = await fetch(
  `${API_BASE}/projects/${cr.projectId}/database-connections`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
).then((r) => r.json());
const apiBlob = JSON.stringify({ provision, connections });
const apiLeakHits = {
  password: password && apiBlob.includes(password) ? 1 : 0,
  databaseUrl: databaseUrl && apiBlob.includes(databaseUrl) ? 1 : 0,
  accessKey: secrets.accessKey && apiBlob.includes(secrets.accessKey) ? 1 : 0,
  secretKey: secrets.secretKey && apiBlob.includes(secrets.secretKey) ? 1 : 0,
};

console.log(
  JSON.stringify(
    {
      rdsCount: instances.length,
      rdsIds: instances.map((i) => i.DBInstanceId),
      whitelist: arrays.map((a) => ({
        name: a.name,
        attr: a.attr,
        ipsMasked: a.ips.map((ip) => {
          const p = ip.split(/[./]/);
          return p.length >= 2 ? `${p[0]}.${p[1]}.***` : '***';
        }),
      })),
      hasOpenWorld,
      launchosHasOnlyTargetStyle: launchosIps.every(
        (ip) => ip.startsWith('8.138.') || ip === '8.138.113.134',
      ),
      privileges: privs.map((p) => ({
        db: p.DBName || p.dbName,
        privilege: p.AccountPrivilege || p.accountPrivilege,
      })),
      logSecretHits: hits,
      apiResponseLeakHits: apiLeakHits,
      createInstanceCompleted: meta.createInstanceCompleted === true,
      providerResourceId: cr.providerResourceId,
      networkMode: meta.networkMode,
      connectionHostMasked: meta.connectionHost
        ? `${String(meta.connectionHost).slice(0, 28)}***`
        : null,
      connectionId: conn?.id || null,
      providerRef: dbUrlValue?.providerRef || null,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
