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
const Kv = requireP('@alicloud/r-kvstore20150101');
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
config.endpoint = 'r-kvstore.aliyuncs.com';
const kv = new Kv.default(config);

async function probe(label, fn) {
  try {
    await fn();
    console.log(JSON.stringify({ label, ok: true }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error?.code || error?.data?.Code;
    console.log(
      JSON.stringify({
        label,
        ok: false,
        code,
        message: String(message).slice(0, 300),
      }),
    );
  }
}

await probe('DescribeInstances', () =>
  kv.describeInstances(
    new Kv.DescribeInstancesRequest({ regionId: 'cn-hangzhou', pageSize: 1, pageNumber: 1 }),
  ),
);
await probe('CreateInstance DryRun', () =>
  kv.createInstance(
    new Kv.CreateInstanceRequest({
      regionId: 'cn-hangzhou',
      instanceClass: 'redis.master.micro.default',
      instanceType: 'Redis',
      engineVersion: '5.0',
      chargeType: 'PostPaid',
      password: 'LaunchosDryRun1!',
      securityIPList: '127.0.0.1',
      dryRun: true,
    }),
  ),
);
await prisma.$disconnect();
