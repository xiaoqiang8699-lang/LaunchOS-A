/**
 * Dry-run validate existing CloudResource against live availability. No CreateInstance.
 *
 * Usage:
 *   node scripts/step-254-validate-existing-cr.mjs cmu4xn1j60001riaw6gjh0rfn
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
const {
  AlibabaCloudRedisProvider,
  diagnoseRedisSkuSelection,
  selectRedisTierFromAvailability,
  buildCreateInstanceRequestPreview,
} = require(resolve(root, 'packages/providers/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const openapi = requireP('@alicloud/openapi-core');
const Ecs = requireP('@alicloud/ecs20140526');

const prisma = new PrismaClient();
const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
if (!cr) throw new Error(`CloudResource ${CR} not found`);
const meta = cr.metadata || {};
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

let placementZone = meta.placementZoneId || null;
if (!placementZone && meta.vSwitchId) {
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
  const list = resp.body?.vSwitches?.vSwitch || [];
  const arr = Array.isArray(list) ? list : [];
  const hit = arr.find((x) => x.vSwitchId === meta.vSwitchId) || arr[0];
  placementZone = hit?.zoneId || null;
}

const resources = await provider.describeAllAvailableResources(region);
const tier = meta.tier || 'DEV';

const existingResolved =
  meta.resolvedSku && typeof meta.resolvedSku === 'object' ? meta.resolvedSku : null;
const existingComplete =
  existingResolved?.instanceClass &&
  existingResolved?.engineVersion &&
  existingResolved?.storageType &&
  existingResolved?.zoneId;
const existingCompatible =
  existingComplete &&
  (!placementZone || existingResolved.zoneId === placementZone);

let resolvedSku;
let skuSource;
if (existingCompatible) {
  // Do not overwrite placement-validated SKU with a fresh tier recommendation.
  resolvedSku = {
    tier: existingResolved.tier || tier,
    instanceClass: existingResolved.instanceClass,
    engineVersion: existingResolved.engineVersion,
    storageType: existingResolved.storageType,
    capacityMb: existingResolved.capacityMb ?? 1024,
    zoneId: existingResolved.zoneId,
    architecture: existingResolved.architecture || null,
    selectionReason: existingResolved.selectionReason || null,
    fallbackReason: existingResolved.fallbackReason || null,
    availabilityFingerprint: existingResolved.availabilityFingerprint || null,
  };
  skuSource = 'preserved-existing-resolvedSku';
} else {
  const selected = selectRedisTierFromAvailability(resources, {
    preferredZoneId: placementZone || undefined,
  }).find((item) => item.tier === tier);

  if (!selected) throw new Error('no tier selection for placement zone');

  resolvedSku = {
    tier,
    instanceClass: selected.instanceClass,
    engineVersion: selected.engineVersion,
    storageType: selected.storageType,
    capacityMb: selected.capacityMb,
    zoneId: placementZone || selected.zoneId,
    architecture: selected.architecture,
    selectionReason: selected.selectionReason,
    fallbackReason: selected.fallbackReason,
    availabilityFingerprint: [
      region,
      selected.storageType,
      selected.instanceClass,
      selected.engineVersion,
      selected.capacityMb ?? '',
      placementZone || selected.zoneId || '',
    ].join('|'),
  };
  skuSource = 're-resolved-for-placement-zone';

  await prisma.cloudResource.update({
    where: { id: CR },
    data: {
      metadata: {
        ...meta,
        ...resolvedSku,
        resolvedSku,
        placementZoneId: placementZone,
        skuReResolvedForPlacementZone: true,
      },
    },
  });
}

const diagnosis = diagnoseRedisSkuSelection(resources, {
  region,
  zoneId: resolvedSku.zoneId,
  instanceClass: resolvedSku.instanceClass,
  engineVersion: resolvedSku.engineVersion,
  storageType: resolvedSku.storageType,
  capacityMb: resolvedSku.capacityMb,
  requireArchitecture: false,
});

const preview = buildCreateInstanceRequestPreview({
  region,
  zoneId: resolvedSku.zoneId,
  instanceClass: resolvedSku.instanceClass,
  engineVersion: resolvedSku.engineVersion,
  storageType: resolvedSku.storageType,
  architecture: resolvedSku.architecture,
  capacityMb: resolvedSku.capacityMb,
  vpcId: meta.vpcId || 'vpc-preview',
});

const byName = await provider.listInstancesByName(
  region,
  String(meta.instanceName || 'launchos-launchos'),
);

console.log(
  JSON.stringify(
    {
      cloudResourceId: CR,
      CREATE_API_CALLED: false,
      createInstanceAttemptCount: meta.createInstanceAttemptCount ?? 0,
      createInstanceSuccessCount: meta.createInstanceSuccessCount ?? 0,
      orphanCount: byName.length,
      placementZone,
      skuSource,
      previousResolvedSku: meta.resolvedSku || null,
      currentResolvedSku: resolvedSku,
      validation: diagnosis.valid ? 'VALID' : 'INVALID',
      diagnosis: {
        failedField: diagnosis.failedField || null,
        match: diagnosis.match,
        availableZones: diagnosis.availableZones,
        checkedAt: diagnosis.checkedAt,
      },
      createInstanceRequestPreview: preview,
      providerAttemptNow: provider.createInstanceAttemptCount,
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
process.exit(diagnosis.valid ? 0 : 2);
