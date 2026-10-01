/**
 * Step 25.4 Aliyun Redis provision E2E.
 * Default: dry-run (no CreateInstance / no --confirm-billing / no enqueue).
 *
 * Resume a FAILED CloudResource:
 *   node scripts/step-254-aliyun-redis-e2e.mjs --cloud-resource-id=cmu4xn1j60001riaw6gjh0rfn
 *
 * Real create (only when explicitly requested later):
 *   node scripts/step-254-aliyun-redis-e2e.mjs --confirm-billing --cloud-resource-id=...
 */
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
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

const confirmBilling = process.argv.includes('--confirm-billing');
const crArg = process.argv.find((a) => a.startsWith('--cloud-resource-id='));
const RESUME_CR_ID =
  (crArg && crArg.slice('--cloud-resource-id='.length)) ||
  process.env.E2E_REDIS_CLOUD_RESOURCE_ID ||
  'cmu4xn1j60001riaw6gjh0rfn';

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const API_UNIT = process.env.E2E_API_UNIT_ID || 'cmu3j272x0005ri7wlxlbajeu';
const WEB_UNIT = process.env.E2E_WEB_UNIT_ID || 'cmu3j27340007ri7wcno1xrai';
const ENV_ID = process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';
const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential, parseAliyunRedisProviderError } = require(
  resolve(root, 'packages/shared/dist/index.js'),
);
const {
  AlibabaCloudCapabilityService,
  AlibabaCloudRedisProvider,
  buildCreateInstanceRequestPreview,
} = require(resolve(root, 'packages/providers/dist/index.js'));

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(
      Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText,
    );
  }
  const blob = JSON.stringify(json);
  if (/accessKeySecret|secretKey|passwordEncrypted|redis:\/\/[^:]+:[^@]+@/i.test(blob)) {
    throw new Error('possible secret leak in API response');
  }
  return json;
}

function fileMtime(rel) {
  try {
    return statSync(resolve(root, rel)).mtime.toISOString();
  } catch {
    return null;
  }
}

function asSku(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const instanceClass = raw.instanceClass ? String(raw.instanceClass) : '';
  const engineVersion = raw.engineVersion ? String(raw.engineVersion) : '';
  const storageType = raw.storageType ? String(raw.storageType) : '';
  const zoneId = raw.zoneId ? String(raw.zoneId) : '';
  if (!instanceClass || !engineVersion || !storageType) return null;
  return {
    tier: raw.tier || 'DEV',
    instanceClass,
    engineVersion,
    storageType,
    capacityMb: raw.capacityMb ?? 1024,
    zoneId: zoneId || null,
    architecture: raw.architecture || null,
    selectionReason: raw.selectionReason || null,
    fallbackReason: raw.fallbackReason || null,
    availabilityFingerprint: raw.availabilityFingerprint || null,
  };
}

function isPlacementCompatible(sku, placementZoneId) {
  if (!sku) return false;
  if (!placementZoneId) return true;
  return !sku.zoneId || sku.zoneId === placementZoneId;
}

const prisma = new PrismaClient();
const login = await api('/auth/login', {
  method: 'POST',
  body: {
    email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
    password: process.env.E2E_PASSWORD || 'Launchos123!',
  },
});
const token = login.accessToken;

const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
  include: { provider: true },
});
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const region = account.region || 'cn-hangzhou';
const capability = await new AlibabaCloudCapabilityService().probe({
  accessKey: secrets.accessKey,
  secretKey: secrets.secretKey,
  region,
});
const provider = new AlibabaCloudRedisProvider({
  accessKey: secrets.accessKey,
  secretKey: secrets.secretKey,
  region,
});

const options = await api(`/projects/${PROJECT_ID}/redis-provisions/options`, { token });
const recommendedTiers = options.tiers || [];
const optionsDevTier = recommendedTiers.find((t) => t.tier === 'DEV') || recommendedTiers[0];

const cr = await prisma.cloudResource.findUnique({ where: { id: RESUME_CR_ID } });
if (!cr) {
  throw new Error(`CloudResource ${RESUME_CR_ID} not found`);
}
const prevMeta = cr.metadata && typeof cr.metadata === 'object' ? cr.metadata : {};
const placementZoneId = prevMeta.placementZoneId || null;

// Authoritative SKU: existing placement-validated resolvedSku must not be overwritten by optionsDevTier.
const existingResolved =
  asSku(prevMeta.resolvedSku) ||
  asSku({
    tier: prevMeta.tier,
    instanceClass: prevMeta.instanceClass,
    engineVersion: prevMeta.engineVersion,
    storageType: prevMeta.storageType,
    capacityMb: prevMeta.capacityMb,
    zoneId: prevMeta.zoneId,
    architecture: prevMeta.architecture,
    selectionReason: prevMeta.selectionReason,
    fallbackReason: prevMeta.fallbackReason,
    availabilityFingerprint: prevMeta.availabilityFingerprint,
  });

let currentResolvedSku = null;
let skuSource = null;
if (existingResolved && isPlacementCompatible(existingResolved, placementZoneId)) {
  currentResolvedSku = existingResolved;
  skuSource = 'cloudResource.resolvedSku';
} else if (
  existingResolved &&
  placementZoneId &&
  existingResolved.storageType === 'Local' &&
  existingResolved.zoneId === placementZoneId
) {
  currentResolvedSku = existingResolved;
  skuSource = 'cloudResource.resolvedSku';
} else {
  // Only select when CR has no usable placement-compatible SKU.
  const specs = await provider.listAvailableSpecs(region, 'DEV');
  const preferredZone = placementZoneId;
  const picked =
    (preferredZone &&
      specs.find((s) => s.zoneId === preferredZone && s.storageType === 'Local')) ||
    (preferredZone && specs.find((s) => s.zoneId === preferredZone)) ||
    specs[0];
  if (!picked?.instanceClass || !picked.engineVersion || !picked.storageType) {
    throw new Error('failed to resolve DEV SKU from availability');
  }
  currentResolvedSku = {
    tier: 'DEV',
    instanceClass: picked.instanceClass,
    engineVersion: picked.engineVersion,
    storageType: picked.storageType,
    capacityMb: picked.capacityMb ?? 1024,
    zoneId: preferredZone || picked.zoneId || null,
    architecture: picked.architecture || null,
    selectionReason: picked.selectionReason || null,
    fallbackReason: picked.fallbackReason || null,
    availabilityFingerprint: [
      region,
      picked.storageType,
      picked.instanceClass,
      picked.engineVersion,
      picked.capacityMb ?? '',
      preferredZone || picked.zoneId || '',
    ].join('|'),
  };
  skuSource = 'availability-select-for-missing-sku';
  await prisma.cloudResource.update({
    where: { id: RESUME_CR_ID },
    data: {
      metadata: {
        ...prevMeta,
        ...currentResolvedSku,
        resolvedSku: currentResolvedSku,
      },
    },
  });
}

const requestPreview = buildCreateInstanceRequestPreview({
  region,
  zoneId: currentResolvedSku.zoneId,
  instanceClass: currentResolvedSku.instanceClass,
  engineVersion: currentResolvedSku.engineVersion,
  storageType: currentResolvedSku.storageType,
  architecture: currentResolvedSku.architecture,
  capacityMb: currentResolvedSku.capacityMb,
  vpcId: 'vpc-preview-only',
});

let priceEstimate = null;
try {
  const estimate = await provider.getPriceEstimate({
    region,
    zoneId: currentResolvedSku.zoneId || undefined,
    instanceClass: currentResolvedSku.instanceClass,
    engineVersion: currentResolvedSku.engineVersion,
    capacityMb: currentResolvedSku.capacityMb,
    storageType: currentResolvedSku.storageType,
    chargeType: 'PostPaid',
  });
  priceEstimate = {
    available: Boolean(estimate.available),
    currency: estimate.currency,
    originalPrice: estimate.originalPrice,
    tradePrice: estimate.tradePrice,
    discountPrice: estimate.discountPrice,
    billingCycle: estimate.billingCycle,
    hourlyPrice: estimate.hourlyPrice,
    priceUnit: estimate.priceUnit,
    providerRequestId: estimate.providerRequestId,
    checkedAt: estimate.checkedAt,
    sku: {
      instanceClass: currentResolvedSku.instanceClass,
      engineVersion: currentResolvedSku.engineVersion,
      storageType: currentResolvedSku.storageType,
      zoneId: currentResolvedSku.zoneId,
      capacityMb: currentResolvedSku.capacityMb,
    },
  };
} catch (error) {
  const text = error instanceof Error ? error.message : String(error);
  const parsed = parseAliyunRedisProviderError(error);
  priceEstimate = {
    available: false,
    currency: null,
    originalPrice: null,
    tradePrice: null,
    discountPrice: null,
    billingCycle: null,
    hourlyPrice: null,
    priceUnit: null,
    providerRequestId: parsed.providerRequestId,
    providerErrorCode: parsed.providerErrorCode,
    httpStatus: parsed.httpStatus,
    technicalMessage: text.slice(0, 1500),
    sku: {
      instanceClass: currentResolvedSku.instanceClass,
      engineVersion: currentResolvedSku.engineVersion,
      storageType: currentResolvedSku.storageType,
      zoneId: currentResolvedSku.zoneId,
      capacityMb: currentResolvedSku.capacityMb,
    },
  };
}

const refreshed = await prisma.cloudResource.findUnique({ where: { id: RESUME_CR_ID } });
const meta = refreshed?.metadata || {};
const byName = await provider.listInstancesByName(
  region,
  String(meta.instanceName || 'launchos-launchos'),
);

const workerSrc = fileMtime('apps/worker/src/redis-provision-executor.ts');
const workerDist = fileMtime('apps/worker/dist/redis-provision-executor.js');
const providerSrc = fileMtime('packages/providers/src/aliyun/alibaba-cloud-redis-provider.ts');
const providerDist = fileMtime('packages/providers/dist/aliyun/alibaba-cloud-redis-provider.js');

console.log(
  JSON.stringify(
    {
      mode: confirmBilling ? 'CONFIRM_BILLING' : 'DRY_RUN',
      resumeCloudResourceId: RESUME_CR_ID,
      redisCapability: capability.capabilities.redis,
      recommendedTiers,
      optionsDevTier: optionsDevTier,
      currentResolvedSku: {
        ...currentResolvedSku,
        source: skuSource,
        placementZoneId,
        preservedExistingSku: skuSource === 'cloudResource.resolvedSku',
      },
      priceEstimate,
      createInstanceRequestPreview: requestPreview,
      workerBuildEvidence: {
        workerSrc,
        workerDist,
        providerSrc,
        providerDist,
        note: 'Compare live Worker PID start time vs dist mtimes after restart.',
      },
      orphanCheck: {
        instanceName: meta.instanceName,
        count: byName.length,
        ids: byName,
      },
      providerCreateCounters: {
        attempt: provider.createInstanceAttemptCount,
        success: provider.createInstanceSuccessCount,
      },
      note:
        'recommendedTiers/optionsDevTier are candidates only; currentResolvedSku is authoritative for this CloudResource.',
    },
    null,
    2,
  ),
);

if (!confirmBilling) {
  console.log(
    'Dry-run only. Did not overwrite placement-compatible resolvedSku with optionsDevTier. No CreateInstance. No queue enqueue.',
  );
  await prisma.$disconnect();
  process.exit(0);
}

// Billing path: resume specified CloudResource; never invent a new one when ID provided.
const created = await api(`/projects/${PROJECT_ID}/redis-provisions`, {
  method: 'POST',
  token,
  body: {
    tier: 'DEV',
    unitIds: [API_UNIT],
    confirmBilling: true,
    confirmReplaceManual: true,
    serverInstanceId: SERVER_ID,
    cloudResourceId: RESUME_CR_ID,
  },
});
console.log('resumed/created', created.id, created.status, created.phase, {
  instanceClass: created.instanceClass,
  engineVersion: created.engineVersion,
  storageType: created.storageType,
});

if (created.id !== RESUME_CR_ID) {
  console.error('ERROR: expected resume of', RESUME_CR_ID, 'but got', created.id);
}

let status = created;
const started = Date.now();
while (Date.now() - started < 25 * 60_000) {
  status = await api(`/projects/${PROJECT_ID}/redis-provisions/${created.id}`, { token });
  console.log(
    `phase=${status.phase} status=${status.status} provider=${status.providerResourceId || '-'} sku=${status.instanceClass}/${status.engineVersion}/${status.storageType} elapsed=${status.elapsedSeconds}s`,
  );
  if (status.statusRaw === 'RUNNING' || status.status === '可用') break;
  if (status.statusRaw === 'FAILED' || status.status === '创建失败') {
    console.error('failed', status.errorMessage, status.providerErrorCode);
    break;
  }
  await new Promise((r) => setTimeout(r, 8000));
}

const finalCr = await prisma.cloudResource.findUnique({ where: { id: created.id } });
const finalMeta = finalCr?.metadata || {};
console.log(
  JSON.stringify(
    {
      final: {
        id: created.id,
        status: finalCr?.status,
        providerResourceId: finalCr?.providerResourceId,
        attempt: finalMeta.createInstanceAttemptCount,
        success: finalMeta.createInstanceSuccessCount,
        resolvedSku: finalMeta.resolvedSku,
      },
      env: ENV_ID,
      webUnit: WEB_UNIT,
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
