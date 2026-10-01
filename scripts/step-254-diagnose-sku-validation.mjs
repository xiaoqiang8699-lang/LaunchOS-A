/**
 * Diagnose validateRedisSkuSelection failure for Step 25.4. No CreateInstance.
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

const CR = process.argv[2] || 'cmu4xn1j60001riaw6gjh0rfn';
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudRedisProvider } = require(resolve(root, 'packages/providers/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const openapi = requireP('@alicloud/openapi-core');
const Ecs = requireP('@alicloud/ecs20140526');

const prisma = new PrismaClient();
const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
const meta = cr?.metadata || {};
const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
});
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const region = cr.region || 'cn-hangzhou';
const provider = new AlibabaCloudRedisProvider({
  accessKey: secrets.accessKey,
  secretKey: secrets.secretKey,
  region,
});

const resources = await provider.describeAllAvailableResources(region);
const small = resources.filter((x) => x.instanceClass === 'redis.shard.small.ce' && x.available);

let placementZone = null;
let vSwitchLookupError = null;
try {
  const cfg = new openapi.$OpenApiUtil.Config({
    accessKeyId: secrets.accessKey,
    accessKeySecret: secrets.secretKey,
  });
  cfg.endpoint = `ecs.${region}.aliyuncs.com`;
  const ecs = new Ecs.default(cfg);
  const resp = await ecs.describeVSwitches(
    new Ecs.DescribeVSwitchesRequest({
      regionId: region,
      vpcId: meta.vpcId,
      vSwitchId: meta.vSwitchId,
    }),
  );
  const list =
    resp.body?.vSwitches?.vSwitch ||
    resp.body?.VSwitches?.VSwitch ||
    [];
  const arr = Array.isArray(list) ? list : [];
  const hit =
    arr.find((x) => (x.vSwitchId || x.VSwitchId) === meta.vSwitchId) || arr[0] || null;
  placementZone = hit?.zoneId || hit?.ZoneId || null;
} catch (e) {
  vSwitchLookupError = String(e?.message || e).slice(0, 200);
}

const candidate = {
  region,
  zoneId: placementZone,
  resolvedZoneId: meta.zoneId || meta.resolvedSku?.zoneId,
  instanceClass: meta.instanceClass || meta.resolvedSku?.instanceClass,
  engineVersion: meta.engineVersion || meta.resolvedSku?.engineVersion,
  storageType: meta.storageType || meta.resolvedSku?.storageType,
  capacityMb: meta.capacityMb ?? meta.resolvedSku?.capacityMb,
  architecture: meta.architecture || meta.resolvedSku?.architecture,
};

const match = {
  matchInstanceClass: small.length > 0,
  matchEngineVersion: small.some((x) => x.engineVersion === candidate.engineVersion),
  matchStorageType: small.some((x) => x.storageType === candidate.storageType),
  matchCapacity: small.some((x) => x.capacityMb === candidate.capacityMb),
  matchZone: small.some(
    (x) =>
      x.zoneId === placementZone &&
      x.engineVersion === candidate.engineVersion &&
      x.storageType === candidate.storageType &&
      x.capacityMb === candidate.capacityMb,
  ),
  matchZoneResolved: small.some(
    (x) =>
      x.zoneId === candidate.resolvedZoneId &&
      x.engineVersion === candidate.engineVersion &&
      x.storageType === candidate.storageType &&
      x.capacityMb === candidate.capacityMb,
  ),
  matchArchitecture: small.some((x) => x.architecture === candidate.architecture),
};

let FAILED_PREDICATE = 'none';
if (!match.matchInstanceClass) FAILED_PREDICATE = 'instanceClass';
else if (!match.matchEngineVersion) FAILED_PREDICATE = 'engineVersion';
else if (!match.matchStorageType) FAILED_PREDICATE = 'storageType';
else if (!match.matchCapacity) FAILED_PREDICATE = 'capacityMb';
else if (!match.matchZone) FAILED_PREDICATE = 'zoneId';
else if (!match.matchArchitecture) FAILED_PREDICATE = 'architecture(soft-only)';

const byName = await provider.listInstancesByName(
  region,
  String(meta.instanceName || 'launchos-launchos'),
);

console.log(
  JSON.stringify(
    {
      CREATE_API_CALLED: Number(meta.createInstanceAttemptCount || 0) > 0,
      createInstanceAttemptCount: meta.createInstanceAttemptCount ?? null,
      createInstanceSuccessCount: meta.createInstanceSuccessCount ?? null,
      orphanCount: byName.length,
      vSwitchId: meta.vSwitchId,
      placementZone,
      vSwitchLookupError,
      resolvedZone: candidate.resolvedZoneId,
      zoneMismatch: placementZone !== candidate.resolvedZoneId,
      candidate,
      match,
      FAILED_PREDICATE,
      zonesForExactCombo: [
        ...new Set(
          small
            .filter(
              (x) =>
                x.engineVersion === candidate.engineVersion &&
                x.storageType === candidate.storageType &&
                x.capacityMb === candidate.capacityMb,
            )
            .map((x) => x.zoneId),
        ),
      ],
      architectures: [...new Set(small.map((x) => x.architecture))],
      smallCe70OnECS: small
        .filter((x) => x.engineVersion === '7.0' && x.storageType === 'OnECS')
        .map((x) => ({
          zoneId: x.zoneId,
          capacityMb: x.capacityMb,
          architecture: x.architecture,
          available: x.available,
          seriesType: x.seriesType,
          editionType: x.editionType,
        })),
      providerAttemptNow: provider.createInstanceAttemptCount,
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
