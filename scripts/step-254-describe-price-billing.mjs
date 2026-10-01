/**
 * Read-only DescribePrice + billing readiness for Step 25.4.
 * Never calls CreateInstance / confirm-billing / delete.
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
const { decryptCredential, parseAliyunRedisProviderError } = require(
  resolve(root, 'packages/shared/dist/index.js'),
);
const { AlibabaCloudRedisProvider } = require(resolve(root, 'packages/providers/dist/index.js'));

const prisma = new PrismaClient();
const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
if (!cr) {
  console.error('CloudResource not found');
  process.exit(1);
}
const meta = cr.metadata && typeof cr.metadata === 'object' ? cr.metadata : {};
const sku = meta.resolvedSku || {};
const region = cr.region || meta.region || 'cn-hangzhou';
const instanceClass = sku.instanceClass || meta.instanceClass || 'redis.master.small.default';
const engineVersion = sku.engineVersion || meta.engineVersion || '5.0';
const storageType = sku.storageType || meta.storageType || 'Local';
const zoneId = sku.zoneId || meta.zoneId || 'cn-hangzhou-i';
const capacityMb = sku.capacityMb || meta.capacityMb || 1024;

const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
});
if (!account) {
  console.error('No ACTIVE Aliyun provider account');
  process.exit(1);
}
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const provider = new AlibabaCloudRedisProvider({
  accessKey: secrets.accessKey,
  secretKey: secrets.secretKey,
  region,
});

const tech = String(meta.technicalMessage || '');
const parsed = parseAliyunRedisProviderError(new Error(tech));
const lastCode = meta.providerErrorCode || parsed.providerErrorCode || null;

let priceEstimate = null;
let priceError = null;
try {
  priceEstimate = await provider.getPriceEstimate({
    region,
    zoneId,
    instanceClass,
    engineVersion,
    capacityMb,
    storageType,
    chargeType: 'PostPaid',
  });
} catch (error) {
  priceError = error instanceof Error ? error.message : String(error);
}

const parsedPriceError = priceError
  ? parseAliyunRedisProviderError(new Error(priceError))
  : { providerErrorCode: null, providerRequestId: null, httpStatus: null, providerErrorMessage: '' };

if (!priceEstimate) {
  priceEstimate = {
    available: false,
    currency: null,
    originalPrice: null,
    tradePrice: null,
    discountPrice: null,
    billingCycle: null,
    hourlyPrice: null,
    priceUnit: null,
    providerRequestId: parsedPriceError.providerRequestId,
    providerErrorCode: parsedPriceError.providerErrorCode,
    httpStatus: parsedPriceError.httpStatus,
    technicalMessage: priceError,
    checkedAt: new Date().toISOString(),
    region,
    zoneId,
    instanceClass,
    engineVersion,
    capacityMb,
    chargeType: 'PostPaid',
    minimumBalanceRequirement: 'UNKNOWN',
  };
}

const billingReadiness = provider.checkBillingReadiness({
  priceEstimate,
  lastProviderErrorCode: lastCode,
  priceErrorCode: priceError && /Forbidden|not authorized/i.test(priceError) ? 'Forbidden.RAM' : null,
});

const financeProbe = {
  unpaidOrder: 'UNKNOWN',
  unsettledBill:
    String(lastCode || '').includes('UNSETTLED')
      ? 'INDICATED_BY_ERROR'
      : lastCode === 'PAY.INSUFFICIENT_BALANCE'
        ? 'NOT_INDICATED_BY_LAST_ERROR'
        : 'UNKNOWN',
  paymentMethodRestriction: 'UNKNOWN',
  accountCreditRestriction: 'UNKNOWN',
  financeAccountRestriction: 'UNKNOWN',
  note:
    'Redis/KVStore API 不提供账户余额、未支付订单、信控额度查询；未接入 BSS OpenAPI，故标记 UNKNOWN。',
};

await prisma.cloudResource.update({
  where: { id: CR },
  data: {
    metadata: {
      ...meta,
      priceEstimate,
      billingReadiness,
      financeProbe,
      priceDiagnosedAt: new Date().toISOString(),
      providerErrorCode: lastCode || meta.providerErrorCode || null,
      providerRequestId: parsed.providerRequestId || meta.providerRequestId || null,
    },
  },
});

console.log(
  JSON.stringify(
    {
      cloudResourceId: CR,
      sku: { region, zoneId, instanceClass, engineVersion, storageType, capacityMb },
      describePriceAvailable: Boolean(priceEstimate?.available),
      priceError,
      priceEstimate,
      billingReadiness,
      financeProbe,
      lastProviderError: {
        providerErrorCode: lastCode,
        requestId: parsed.providerRequestId || meta.providerRequestId || null,
        technicalMessage: tech.slice(0, 400),
      },
      createInstanceAttemptCount: meta.createInstanceAttemptCount ?? 0,
      createInstanceSuccessCount: meta.createInstanceSuccessCount ?? 0,
      providerResourceId: cr.providerResourceId,
      recommendedMinimumBalance: 'UNKNOWN',
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
