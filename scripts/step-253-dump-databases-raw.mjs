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
const resp = await rds.describeDatabases(
  new rdsPkg.DescribeDatabasesRequest({
    DBInstanceId: 'pgm-bp14j1lljy571v8h',
    pageSize: 100,
    pageNumber: 1,
  }),
);
const body = resp.body || {};
console.log('bodyKeys', Object.keys(body));
console.log('databasesKeys', Object.keys(body.databases || body.Databases || {}));
console.log(
  'raw',
  JSON.stringify(body, null, 2)
    .replace(/password[^,\n]*/gi, 'password=[REDACTED]')
    .slice(0, 4000),
);

const ips = await rds.describeDBInstanceIPArrayList(
  new rdsPkg.DescribeDBInstanceIPArrayListRequest({
    DBInstanceId: 'pgm-bp14j1lljy571v8h',
  }),
);
console.log(
  'whitelist',
  JSON.stringify(
    (ips.body?.items?.DBInstanceIPArray || ips.body?.Items?.DBInstanceIPArray || []).map((x) => ({
      name: x.DBInstanceIPArrayName || x.dBInstanceIPArrayName,
      attr: x.DBInstanceIPArrayAttribute || x.dBInstanceIPArrayAttribute,
      ipCount: String(x.securityIPList || x.SecurityIPList || '')
        .split(',')
        .filter(Boolean).length,
      ipsMasked: String(x.securityIPList || x.SecurityIPList || '')
        .split(',')
        .filter(Boolean)
        .map((ip) => {
          const p = ip.trim().split('.');
          return p.length === 4 ? `${p[0]}.${p[1]}.***.***` : '***';
        }),
    })),
    null,
    2,
  ),
);
await prisma.$disconnect();
