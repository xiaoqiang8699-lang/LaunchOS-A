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
const ecsPkg = requireP('@alicloud/ecs20140526');
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
const n = (net.body?.DBInstanceNetInfos?.DBInstanceNetInfo || [])[0] || {};
const vpcId = n.VPCId || n.vpcId;
console.log('rdsVpc', vpcId ? `${String(vpcId).slice(0, 10)}***` : null);

const ecsConfig = new openapi.$OpenApiUtil.Config({
  accessKeyId: secrets.accessKey,
  accessKeySecret: secrets.secretKey,
});
ecsConfig.endpoint = 'ecs.cn-hangzhou.aliyuncs.com';
const ecs = new ecsPkg.default(ecsConfig);
if (vpcId) {
  const vpcs = await ecs.describeVpcs(
    new ecsPkg.DescribeVpcsRequest({ regionId: 'cn-hangzhou', vpcId }),
  );
  const v = (vpcs.body?.vpcs?.vpc || [])[0];
  console.log(
    JSON.stringify(
      {
        cidr: v?.cidrBlock,
        name: v?.vpcName,
      },
      null,
      2,
    ),
  );
}
await prisma.$disconnect();
