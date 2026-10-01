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
const attr = await rds.describeDBInstanceAttribute(
  new rdsPkg.DescribeDBInstanceAttributeRequest({ DBInstanceId: 'pgm-bp14j1lljy571v8h' }),
);
const a = attr.body?.items?.DBInstanceAttribute?.[0] || {};
console.log(
  JSON.stringify(
    {
      status: a.DBInstanceStatus || a.dBInstanceStatus,
      lockMode: a.lockMode || a.LockMode,
      lockReason: a.lockReason || a.LockReason,
      conn: a.connectionString || a.ConnectionString
        ? String(a.connectionString || a.ConnectionString).slice(0, 40)
        : null,
    },
    null,
    2,
  ),
);
const cr = await prisma.cloudResource.findUnique({
  where: { id: 'cmu4110xm0001ric027vr0tc3' },
});
const meta = cr.metadata || {};
console.log(
  JSON.stringify(
    {
      crStatus: cr.status,
      phase: meta.phase,
      errorCode: meta.errorCode,
      technicalMessage: meta.technicalMessage,
      providerResourceId: cr.providerResourceId,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
