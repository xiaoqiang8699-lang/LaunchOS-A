/**
 * Step 25.4 RAM/BSS order permission readiness.
 * Never calls CreateInstance / --confirm-billing.
 *
 *   node scripts/step-254-bss-order-readiness.mjs
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

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudCapabilityService } = require(
  resolve(root, 'packages/providers/dist/index.js'),
);

const prisma = new PrismaClient();
const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
  include: { provider: true },
});
if (!account) {
  console.error('No ACTIVE ALIYUN ProviderAccount');
  process.exit(1);
}

const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const region = account.region || 'cn-hangzhou';
const service = new AlibabaCloudCapabilityService();
const report = await service.probe(
  {
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region,
  },
  { skipCreateDryRuns: true },
);

const out = {
  mode: 'DRY_RUN_BSS_ORDER_READINESS',
  CREATE_API_CALLED: false,
  confirmBilling: false,
  providerAccountId: account.id,
  region,
  BILLING_ORDER_PERMISSION: report.BILLING_ORDER_PERMISSION || 'UNKNOWN',
  redisResourcePermission: report.capabilities.redis?.actions?.resource || 'UNKNOWN',
  redisPricePermission: report.capabilities.redis?.actions?.price || 'UNKNOWN',
  billingOrderPermission: report.capabilities.billing?.actions?.order || 'UNKNOWN',
  billingDetail: report.capabilities.billing?.detail || null,
  labels: report.labels.filter((l) =>
    ['redis_resource', 'redis_price', 'billing_order', 'redis'].includes(l.key),
  ),
  recommendedPolicy: 'AliyunBSSOrderAccess',
  notRecommended: 'AliyunBSSFullAccess',
  billingOrderBlocked: service.isBillingOrderBlocked(report),
};

console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
process.exit(out.BILLING_ORDER_PERMISSION === 'MISSING_PERMISSION' ? 2 : 0);
