/**
 * Read-only: dump netinfo / databases / accounts for bound RDS.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ID = 'pgm-bp14j1lljy571v8h';

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
  new rdsPkg.DescribeDBInstanceNetInfoRequest({ DBInstanceId: ID }),
);
const attr = await rds.describeDBInstanceAttribute(
  new rdsPkg.DescribeDBInstanceAttributeRequest({ DBInstanceId: ID }),
);
const a = attr.body?.items?.DBInstanceAttribute?.[0] || {};
const dbs = await rds.describeDatabases(
  new rdsPkg.DescribeDatabasesRequest({ DBInstanceId: ID, pageSize: 100, pageNumber: 1 }),
);
const accts = await rds.describeAccounts(
  new rdsPkg.DescribeAccountsRequest({ DBInstanceId: ID, pageSize: 100, pageNumber: 1 }),
);

const rawAcct = accts.body?.accounts?.DBInstanceAccount?.[0];
const net0 = (net.body?.DBInstanceNetInfos?.DBInstanceNetInfo || [])[0] || {};
const dbItems = dbs.body?.databases?.Database || [];
console.log(
  JSON.stringify(
    {
      status: a.DBInstanceStatus,
      netRequestId: net.body?.requestId || null,
      casingCheck: {
        connectionStringCamelPresent: Boolean(net0.connectionString),
        ConnectionStringPascalPresent: Boolean(net0.ConnectionString),
        connectionStringMasked: net0.connectionString
          ? `${String(net0.connectionString).slice(0, 20)}***`
          : null,
        portCamel: net0.port ?? null,
        PortPascal: net0.Port ?? null,
      },
      attrConnectionStringPresent: Boolean(a.ConnectionString || a.connectionString),
      databases: dbItems.map((d) => ({
        DBName: d.DBName,
        dbName: d.dbName,
        status: d.DBStatus || d.dBStatus,
      })),
      accounts: (accts.body?.accounts?.DBInstanceAccount || []).map((x) => ({
        accountName: x.accountName || x.AccountName,
        accountType: x.accountType || x.AccountType,
        accountStatus: x.accountStatus || x.AccountStatus,
        privCount: (x.databasePrivileges?.DatabasePrivilege || []).length,
      })),
      getConnectionInfoWouldFail:
        !net0.ConnectionString &&
        !a.ConnectionString &&
        Boolean(net0.connectionString),
      rootCause:
        'SDK returns camelCase connectionString; provider reads PascalCase ConnectionString → false missing endpoint',
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
