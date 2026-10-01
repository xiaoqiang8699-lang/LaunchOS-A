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
const resp = await rds.describeDBInstances(
  new rdsPkg.DescribeDBInstancesRequest({
    regionId: 'cn-hangzhou',
    engine: 'PostgreSQL',
    pageSize: 30,
  }),
);
const items = (resp.body?.items?.DBInstance || [])
  .map((it) => ({
    DBInstanceId: it.DBInstanceId,
    status: it.DBInstanceStatus,
    createTime: it.createTime || it.CreateTime,
    region: it.regionId || it.RegionId,
    zone: it.zoneId || it.ZoneId,
    description: it.DBInstanceDescription,
    engine: it.engine || it.Engine,
    engineVersion: it.engineVersion || it.EngineVersion,
    vpcIdMasked: (it.vpcId || it.VpcId)
      ? `${String(it.vpcId || it.VpcId).slice(0, 8)}***`
      : null,
    vSwitchMasked: (it.vSwitchId || it.VSwitchId)
      ? `${String(it.vSwitchId || it.VSwitchId).slice(0, 8)}***`
      : null,
    class: it.DBInstanceClass,
  }))
  .sort((a, b) => String(a.createTime).localeCompare(String(b.createTime)));

console.log(JSON.stringify(items, null, 2));

const resource = await prisma.cloudResource.findUnique({
  where: { id: 'cmu4110xm0001ric027vr0tc3' },
});
const meta = resource?.metadata || {};
console.log(
  JSON.stringify(
    {
      cloudResourceId: resource?.id,
      providerResourceId: resource?.providerResourceId,
      operationId: meta.operationId,
      clientToken: String(meta.operationId || '').slice(0, 64),
      status: resource?.status,
      phase: meta.phase,
      lastRetryAt: meta.retryingAt || meta.attemptStartedAt,
      expectedDescription: `launchos-${meta.databaseName || ''}`.slice(0, 64),
      phaseTimeline: (meta.phases || []).slice(-8),
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
