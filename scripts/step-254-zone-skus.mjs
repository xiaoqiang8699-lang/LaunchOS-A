/**
 * List purchasable Redis SKUs in a specific zone. No CreateInstance.
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
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const ZONE = process.argv[2] || 'cn-hangzhou-i';
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const {
  AlibabaCloudRedisProvider,
  selectRedisTierFromAvailability,
} = require(resolve(root, 'packages/providers/dist/index.js'));

const prisma = new PrismaClient();
const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
});
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const provider = new AlibabaCloudRedisProvider({
  accessKey: secrets.accessKey,
  secretKey: secrets.secretKey,
  region: 'cn-hangzhou',
});
const all = await provider.describeAllAvailableResources('cn-hangzhou');
const inZone = all.filter((x) => x.available && x.zoneId === ZONE);
const preferred = inZone.filter(
  (x) =>
    (/^redis\.master\./i.test(x.instanceClass) || /^redis\.shard\./i.test(x.instanceClass)) &&
    !/proxy/i.test(x.instanceClass),
);
const unique = [
  ...new Map(
    preferred.map((x) => [
      `${x.storageType}|${x.instanceClass}|${x.engineVersion}|${x.capacityMb}|${x.architecture}`,
      x,
    ]),
  ).values(),
];
const tiers = selectRedisTierFromAvailability(all, { preferredZoneId: ZONE });
console.log(
  JSON.stringify(
    {
      zone: ZONE,
      uniquePreferred: unique
        .sort((a, b) => (a.capacityMb || 0) - (b.capacityMb || 0))
        .slice(0, 30)
        .map((x) => ({
          storageType: x.storageType,
          instanceClass: x.instanceClass,
          engineVersion: x.engineVersion,
          capacityMb: x.capacityMb,
          architecture: x.architecture,
        })),
      selectedTiers: tiers,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
