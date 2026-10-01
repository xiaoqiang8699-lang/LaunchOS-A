/**
 * Manually probe Target Server SELECT 1 for bound RDS (uses RemoteRunner).
 * Does not CreateDBInstance / mutate CloudResource.
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

const CR_ID = 'cmu4110xm0001ric027vr0tc3';
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
const resource = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
const meta = resource.metadata || {};
const password = decryptCredential(meta.passwordEncrypted);
const databaseName = meta.databaseName;
const username = meta.username;
const serverId = meta.serverInstanceId;
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
const conn = await provider.getConnectionInfo(resource.providerResourceId, true);

const config = new openapi.$OpenApiUtil.Config({
  accessKeyId: secrets.accessKey,
  accessKeySecret: secrets.secretKey,
});
config.endpoint = 'rds.aliyuncs.com';
const rds = new rdsPkg.default(config);
const ips = await rds.describeDBInstanceIPArrayList(
  new rdsPkg.DescribeDBInstanceIPArrayListRequest({
    DBInstanceId: resource.providerResourceId,
  }),
);

console.log(
  JSON.stringify(
    {
      server: { id: server.id, host: server.host, port: server.port, name: server.name },
      rds: {
        hostMasked: `${conn.host.slice(0, 24)}***`,
        port: conn.port,
        networkType: conn.networkType,
        databaseName,
        username,
      },
      whitelist: (ips.body?.items?.DBInstanceIPArray || []).map((x) => ({
        name: x.DBInstanceIPArrayName || x.dBInstanceIPArrayName,
        ips: String(x.securityIPList || x.SecurityIPList || '')
          .split(',')
          .filter(Boolean)
          .map((ip) => {
            const p = ip.trim().split(/[./]/);
            return p.length >= 2 ? `${p[0]}.${p[1]}.***` : '***';
          }),
      })),
    },
    null,
    2,
  ),
);

const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});

const envPath = `/tmp/launchos-pg-probe-${Date.now()}.env`;
const envBody = [
  `PGHOST=${conn.host}`,
  `PGPORT=${conn.port}`,
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

console.log(
  JSON.stringify(
    {
      exitCode: result.exitCode,
      stdout: String(result.stdout || '').slice(0, 400),
      stderr: String(result.stderr || '').slice(0, 400),
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
