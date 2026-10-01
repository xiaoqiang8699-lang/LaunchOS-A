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

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const {
  AlibabaCloudDatabaseProvider,
  extractRdsNetEndpoints,
} = require(resolve(root, 'packages/providers/dist/index.js'));
const { RemoteRunner } = require(resolve(root, 'packages/remote-runner/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const rdsPkg = requireP('@alicloud/rds20140815');
const openapi = requireP('@alicloud/openapi-core');

const prisma = new PrismaClient();
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
const net = await rds.describeDBInstanceNetInfo(
  new rdsPkg.DescribeDBInstanceNetInfoRequest({ DBInstanceId: 'pgm-bp14j1lljy571v8h' }),
);
const endpoints = extractRdsNetEndpoints(net.body);
console.log(
  JSON.stringify(
    {
      rawCount: (net.body?.DBInstanceNetInfos?.DBInstanceNetInfo || []).length,
      raw: (net.body?.DBInstanceNetInfos?.DBInstanceNetInfo || []).map((n) => ({
        ipType: n.IPType || n.ipType,
        connType: n.connectionStringType || n.ConnectionStringType,
        hasConn: Boolean(n.connectionString || n.ConnectionString),
        connMasked: String(n.connectionString || n.ConnectionString || '').slice(0, 40),
        port: n.port || n.Port,
        ipMasked: String(n.IPAddress || n.ipAddress || '')
          .split('.')
          .slice(0, 2)
          .concat(['***'])
          .join('.'),
      })),
      normalized: endpoints.map((e) => ({
        ipType: e.ipType,
        connType: e.connectionStringType,
        connMasked: e.connectionString.slice(0, 40),
        port: e.port,
      })),
    },
    null,
    2,
  ),
);

const provider = new AlibabaCloudDatabaseProvider({
  accessKey: secrets.accessKey,
  secretKey: secrets.secretKey,
  region: 'cn-hangzhou',
});
const priv = await provider.getConnectionInfo('pgm-bp14j1lljy571v8h', true);
const pub = await provider.getConnectionInfo('pgm-bp14j1lljy571v8h', false);
console.log(
  JSON.stringify(
    {
      preferPrivate: {
        host: priv.host.slice(0, 40),
        networkType: priv.networkType,
      },
      preferPublic: {
        host: pub.host.slice(0, 40),
        networkType: pub.networkType,
      },
    },
    null,
    2,
  ),
);

const resource = await prisma.cloudResource.findUnique({
  where: { id: 'cmu4110xm0001ric027vr0tc3' },
});
const meta = resource.metadata || {};
const server = await prisma.serverInstance.findUnique({
  where: { id: meta.serverInstanceId },
});
const password = decryptCredential(meta.passwordEncrypted);
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});

const host = pub.host.replace(/[^a-zA-Z0-9.-]/g, '');
const tcp = await runner.execute(
  `timeout 8 bash -lc "exec 3<>/dev/tcp/${host}/${pub.port} && echo ok || echo fail"; echo exit:$?`,
  { timeoutMs: 15_000 },
);
console.log('tcpPublic', String(tcp.stdout || '').trim());

const envPath = `/tmp/pg-pub-${Date.now()}.env`;
await runner.writeTextFile(
  envPath,
  [
    `PGHOST=${pub.host}`,
    `PGPORT=${pub.port}`,
    `PGDATABASE=${meta.databaseName}`,
    `PGUSER=${meta.username}`,
    `PGPASSWORD=${password}`,
  ].join('\n'),
  0o600,
);
try {
  const sel = await runner.execute(
    `docker run --rm --env-file ${envPath} postgres:16-alpine psql -c "SELECT 1 as ok"`,
    { timeoutMs: 60_000 },
  );
  console.log(
    JSON.stringify(
      {
        exitCode: sel.exitCode,
        out: String(sel.stdout || '').slice(0, 200),
        err: String(sel.stderr || '').slice(0, 200),
      },
      null,
      2,
    ),
  );
} finally {
  await runner.execute(`rm -f ${envPath}`, { timeoutMs: 5000 }).catch(() => undefined);
}
await prisma.$disconnect();
