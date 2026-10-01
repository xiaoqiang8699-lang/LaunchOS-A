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
config.endpoint = 'ecs.cn-hangzhou.aliyuncs.com';
const ecs = new ecsPkg.default(config);
const ip = '8.138.113.134';

for (const label of ['publicIpAddresses', 'eipAddresses', 'privateIpAddresses']) {
  try {
    const req = { regionId: 'cn-hangzhou', pageSize: 10 };
    req[label] = JSON.stringify([ip]);
    const resp = await ecs.describeInstances(new ecsPkg.DescribeInstancesRequest(req));
    const list = resp.body?.instances?.instance || [];
    console.log(
      label,
      JSON.stringify(
        list.map((i) => ({
          id: i.instanceId,
          status: i.status,
          public: i.publicIpAddress?.ipAddress || i.eipAddress?.ipAddress,
          private: i.vpcAttributes?.privateIpAddress?.ipAddress,
          vpc: i.vpcAttributes?.vpcId
            ? `${String(i.vpcAttributes.vpcId).slice(0, 8)}***`
            : null,
          vsw: i.vpcAttributes?.vSwitchId
            ? `${String(i.vpcAttributes.vSwitchId).slice(0, 8)}***`
            : null,
        })),
        null,
        2,
      ),
    );
  } catch (err) {
    console.log(label, 'ERR', String(err?.message || err).slice(0, 200));
  }
}

// broad page scan
const broad = await ecs.describeInstances(
  new ecsPkg.DescribeInstancesRequest({ regionId: 'cn-hangzhou', pageSize: 50, pageNumber: 1 }),
);
const hits = (broad.body?.instances?.instance || []).filter((i) => {
  const pubs = [
    ...(i.publicIpAddress?.ipAddress || []),
    i.eipAddress?.ipAddress,
  ].filter(Boolean);
  return pubs.includes(ip);
});
console.log(
  'scanHits',
  JSON.stringify(
    hits.map((i) => ({
      id: i.instanceId,
      status: i.status,
      public: i.publicIpAddress?.ipAddress || i.eipAddress?.ipAddress,
      private: i.vpcAttributes?.privateIpAddress?.ipAddress,
      vpc: i.vpcAttributes?.vpcId ? `${String(i.vpcAttributes.vpcId).slice(0, 8)}***` : null,
    })),
    null,
    2,
  ),
);
await prisma.$disconnect();
