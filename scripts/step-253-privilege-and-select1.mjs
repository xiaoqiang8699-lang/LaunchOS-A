/**
 * Privilege raw + Target Server SELECT 1 + secret scan (no CreateDBInstance).
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

const CR = 'cmu4110xm0001ric027vr0tc3';
const KEEP = 'pgm-bp14j1lljy571v8h';

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudDatabaseProvider } = require(
  resolve(root, 'packages/providers/dist/index.js'),
);
const { RemoteRunner } = require(resolve(root, 'packages/remote-runner/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const rdsPkg = requireP('@alicloud/rds20140815');
const openapi = requireP('@alicloud/openapi-core');

const prisma = new PrismaClient();
const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
const meta = cr.metadata || {};
const password = decryptCredential(meta.passwordEncrypted);
const username = String(meta.username);
const databaseName = String(meta.databaseName);
const host = String(meta.connectionHost);
const port = Number(meta.connectionPort || 5432);
const serverId = String(meta.serverInstanceId);
const server = await prisma.serverInstance.findUnique({ where: { id: serverId } });

const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
});
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const provider = new AlibabaCloudDatabaseProvider({
  accessKey: secrets.accessKey,
  secretKey: secrets.secretKey,
  region: 'cn-hangzhou',
});

const config = new openapi.$OpenApiUtil.Config({
  accessKeyId: secrets.accessKey,
  accessKeySecret: secrets.secretKey,
});
config.endpoint = 'rds.aliyuncs.com';
const rds = new rdsPkg.default(config);

const acctsBefore = await rds.describeAccounts(
  new rdsPkg.DescribeAccountsRequest({
    DBInstanceId: KEEP,
    accountName: username,
    pageSize: 30,
    pageNumber: 1,
  }),
);
const acctBefore =
  (acctsBefore.body?.accounts?.dBInstanceAccount ||
    acctsBefore.body?.accounts?.DBInstanceAccount ||
    [])[0] || null;

function extractPrivs(acct) {
  if (!acct) return [];
  const root = acct.DatabasePrivileges || acct.databasePrivileges || {};
  const list =
    root.DatabasePrivilege ||
    root.databasePrivilege ||
    (Array.isArray(root) ? root : []);
  return (Array.isArray(list) ? list : []).map((p) => ({
    db: p.DBName || p.dbName,
    privilege: p.AccountPrivilege || p.accountPrivilege,
  }));
}

let privilegeAction = 'already_present';
const beforePrivs = extractPrivs(acctBefore);
const hasDbPriv = beforePrivs.some(
  (p) => p.db === databaseName && /DBOwner|ReadWrite|ReadOnly/i.test(String(p.privilege || '')),
);
if (!hasDbPriv) {
  await provider.grantAccountPrivilege({
    dbInstanceId: KEEP,
    accountName: username,
    databaseName,
    privilege: 'DBOwner',
  });
  privilegeAction = 'granted_now';
  await new Promise((r) => setTimeout(r, 3000));
}

const acctsAfter = await rds.describeAccounts(
  new rdsPkg.DescribeAccountsRequest({
    DBInstanceId: KEEP,
    accountName: username,
    pageSize: 30,
    pageNumber: 1,
  }),
);
const acctAfter =
  (acctsAfter.body?.accounts?.dBInstanceAccount ||
    acctsAfter.body?.accounts?.DBInstanceAccount ||
    [])[0] || null;

const dbs = await provider.listDatabaseNames
  ? await provider.listDatabaseNames(KEEP).catch(() => null)
  : null;
const dbListResp = await rds.describeDatabases(
  new rdsPkg.DescribeDatabasesRequest({
    DBInstanceId: KEEP,
    DBName: databaseName,
    pageSize: 30,
    pageNumber: 1,
  }),
);
const dbNames =
  dbListResp.body?.databases?.database ||
  dbListResp.body?.databases?.Database ||
  [];

const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});

const envPath = `/tmp/launchos-pg-probe-${Date.now()}.env`;
const envBody = [
  `PGHOST=${host}`,
  `PGPORT=${port}`,
  `PGDATABASE=${databaseName}`,
  `PGUSER=${username}`,
  `PGPASSWORD=${password}`,
].join('\n');
await runner.writeTextFile(envPath, envBody, 0o600);
const result = await runner.execute(
  `docker run --rm --env-file ${envPath} postgres:16-alpine psql -c "SELECT 1 as ok"`,
  { timeoutMs: 90_000 },
);
await runner.execute(`rm -f ${envPath}`, { timeoutMs: 5_000 }).catch(() => undefined);
await runner.disconnect().catch(() => undefined);

const haystacks = [];
const depLogs = await prisma.deploymentLog.findMany({
  where: { deployment: { projectId: cr.projectId } },
  orderBy: { createdAt: 'desc' },
  take: 1000,
  select: { message: true },
});
haystacks.push(depLogs.map((l) => String(l.message || '')).join('\n'));
for (const dir of [
  resolve(root, 'apps/api/logs'),
  resolve(root, 'apps/worker/logs'),
  resolve(root, 'logs'),
  resolve(root, '.tools/logs'),
]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!/\.(log|txt)$/i.test(f)) continue;
    try {
      haystacks.push(readFileSync(join(dir, f), 'utf8').slice(-500_000));
    } catch {
      /* ignore */
    }
  }
}
const hay = haystacks.join('\n');
const url = `postgresql://${username}:${password}@${host}:${port}/${databaseName}`;
const secretHits = {
  password: password && hay.includes(password) ? 1 : 0,
  databaseUrl: hay.includes(url) ? 1 : 0,
  accessKey: secrets.accessKey && hay.includes(secrets.accessKey) ? 1 : 0,
  secretKey: secrets.secretKey && hay.includes(secrets.secretKey) ? 1 : 0,
};

console.log(
  JSON.stringify(
    {
      resumedWithoutCreate: meta.resumedWithoutCreate === true,
      createInstanceCompleted: meta.createInstanceCompleted === true,
      databaseExists: (Array.isArray(dbNames) ? dbNames : []).some(
        (d) => (d.DBName || d.dbName) === databaseName,
      ),
      accountExists: Boolean(acctAfter),
      accountName: username,
      privilegeAction,
      privilegesBefore: beforePrivs,
      privilegesAfter: extractPrivs(acctAfter),
      accountRawSample: acctAfter
        ? {
            keys: Object.keys(acctAfter),
            DatabasePrivileges: acctAfter.DatabasePrivileges || acctAfter.databasePrivileges || null,
          }
        : null,
      remoteSelect1: {
        exitCode: result.exitCode,
        stdout: String(result.stdout || '').slice(0, 400),
        stderr: String(result.stderr || '').slice(0, 300),
        serverHost: server.host,
        serverPort: server.port,
        endpointHostMasked: `${host.slice(0, 24)}***`,
      },
      networkMode: meta.networkMode,
      secretHits,
      phasesTail: Array.isArray(meta.phases) ? meta.phases.slice(-8) : null,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
