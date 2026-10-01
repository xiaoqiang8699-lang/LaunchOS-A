/**
 * Diagnose CreateDatabase for bound RDS (no CreateDBInstance).
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

const ID = 'pgm-bp14j1lljy571v8h';
const DB = 'launchos_launchos';
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

const before = await rds.describeDatabases(
  new rdsPkg.DescribeDatabasesRequest({ DBInstanceId: ID, pageSize: 100, pageNumber: 1 }),
);
console.log(
  'before',
  JSON.stringify(
    (before.body?.databases?.Database || []).map((d) => ({
      DBName: d.DBName,
      dbName: d.dbName,
      keys: Object.keys(d),
    })),
    null,
    2,
  ),
);

try {
  const resp = await rds.createDatabase(
    new rdsPkg.CreateDatabaseRequest({
      DBInstanceId: ID,
      DBName: DB,
      characterSetName: 'UTF8',
    }),
  );
  console.log(
    'createDatabase ok',
    JSON.stringify(
      {
        requestId: resp.body?.requestId || resp.body?.RequestId || null,
        bodyKeys: Object.keys(resp.body || {}),
      },
      null,
      2,
    ),
  );
} catch (err) {
  console.log(
    'createDatabase error',
    JSON.stringify(
      {
        message: String(err?.message || err).slice(0, 500),
        code: err?.code || err?.data?.Code || null,
        requestId: err?.data?.RequestId || null,
      },
      null,
      2,
    ),
  );
}

await new Promise((r) => setTimeout(r, 3000));
const after = await rds.describeDatabases(
  new rdsPkg.DescribeDatabasesRequest({ DBInstanceId: ID, pageSize: 100, pageNumber: 1 }),
);
console.log(
  'after',
  JSON.stringify(
    {
      requestId: after.body?.requestId || null,
      databases: (after.body?.databases?.Database || []).map((d) => ({
        name: d.DBName || d.dbName,
        status: d.DBStatus || d.dBStatus,
      })),
      rawCount: (after.body?.databases?.Database || []).length,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
