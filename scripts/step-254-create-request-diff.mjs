/**
 * Step 25.4 CreateInstance request-level comparison. No CreateInstance.
 *
 *   node scripts/step-254-create-request-diff.mjs [cloudResourceId]
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
const { decryptCredential, buildCreateInstanceRequestPreview } = (() => {
  const shared = require(resolve(root, 'packages/shared/dist/index.js'));
  const providers = require(resolve(root, 'packages/providers/dist/index.js'));
  return {
    decryptCredential: shared.decryptCredential,
    buildCreateInstanceRequestPreview: providers.buildCreateInstanceRequestPreview,
  };
})();

const prisma = new PrismaClient();
const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
if (!cr) {
  console.error('CloudResource not found');
  process.exit(1);
}
const m = cr.metadata && typeof cr.metadata === 'object' ? cr.metadata : {};
const sku = m.resolvedSku || {};
const region = cr.region || m.region || 'cn-hangzhou';
const preview = buildCreateInstanceRequestPreview({
  region,
  zoneId: sku.zoneId || m.zoneId || m.placementZoneId,
  instanceClass: sku.instanceClass || m.instanceClass,
  engineVersion: sku.engineVersion || m.engineVersion,
  storageType: sku.storageType || m.storageType,
  architecture: sku.architecture || m.architecture,
  capacityMb: sku.capacityMb || m.capacityMb,
  vpcId: m.vpcId,
});

let passwordFlags = null;
if (m.passwordEncrypted) {
  const pwd = decryptCredential(m.passwordEncrypted);
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, /[!@#$%^&*()_+\-=]/].filter((r) =>
    r.test(pwd),
  ).length;
  passwordFlags = {
    length: pwd.length,
    hasUpper: /[A-Z]/.test(pwd),
    hasLower: /[a-z]/.test(pwd),
    hasDigit: /[0-9]/.test(pwd),
    hasSpecial: /[!@#$%^&*()_+\-=]/.test(pwd),
    classes,
    meetsAliyunRule: pwd.length >= 8 && pwd.length <= 32 && classes >= 3,
  };
}

const ramApiRequest = {
  regionId: preview.regionId,
  zoneId: preview.zoneId,
  instanceClass: preview.instanceClass,
  engineVersion: preview.engineVersion,
  instanceType: preview.instanceType,
  chargeType: preview.chargeType,
  networkType: preview.networkType,
  nodeType: preview.nodeType,
  capacity: preview.capacity,
  vpcId: m.vpcId || null,
  vSwitchId: m.vSwitchId || null,
  instanceName: m.instanceName || null,
  token: String(m.operationId || '').slice(0, 64) || null,
  password: passwordFlags,
  securityIPList: 'from placement.whitelist (sanitized, no 0.0.0.0/0)',
  period: null,
  autoRenew: null,
  businessInfo: null,
  couponNo: null,
  resourceGroupId: null,
  architecture_informational_only: preview.architecture,
  storageType_informational_only: preview.storageType,
  dryRun: false,
};

const consoleEquivalent = {
  product: '云数据库 Redis 版 / 社区版（经典）',
  region: '华东1（杭州）cn-hangzhou',
  zone: '可用区 i（cn-hangzhou-i）',
  architecture: '标准版（双副本）',
  version: 'Redis 5.0',
  instanceClass: 'redis.master.small.default（1 GB）',
  chargeType: '按量付费 PostPaid',
  network: '专有网络 VPC + 交换机（同可用区）',
  nodeType_ui: '双副本 → API NodeType=double',
  capacity_ui: '通常由规格隐含；API 可另传 Capacity=1024',
  period: '按量不填',
  clientToken: '控制台无同值 Token；API 幂等 Token 由客户端提供',
};

const fieldDiff = [
  {
    field: 'InstanceClass',
    api: ramApiRequest.instanceClass,
    console: 'redis.master.small.default',
    match: ramApiRequest.instanceClass === 'redis.master.small.default',
  },
  {
    field: 'EngineVersion',
    api: ramApiRequest.engineVersion,
    console: '5.0',
    match: ramApiRequest.engineVersion === '5.0',
  },
  {
    field: 'NodeType',
    api: ramApiRequest.nodeType,
    console: 'double（经典双副本）',
    match: ramApiRequest.nodeType === 'double',
  },
  {
    field: 'InstanceType',
    api: ramApiRequest.instanceType,
    console: 'Redis',
    match: ramApiRequest.instanceType === 'Redis',
  },
  {
    field: 'ChargeType',
    api: ramApiRequest.chargeType,
    console: 'PostPaid',
    match: ramApiRequest.chargeType === 'PostPaid',
  },
  {
    field: 'ZoneId',
    api: ramApiRequest.zoneId,
    console: 'cn-hangzhou-i',
    match: ramApiRequest.zoneId === 'cn-hangzhou-i',
  },
  {
    field: 'Capacity',
    api: ramApiRequest.capacity,
    console: '规格隐含 1024MB；控制台常不单独传',
    match: ramApiRequest.capacity === 1024,
    note: 'API 同时传 InstanceClass+Capacity；与规格一致，非错误，但是与控制台常见请求的差异点',
  },
  {
    field: 'NetworkType/VpcId/VSwitchId',
    api: `${ramApiRequest.networkType}/${Boolean(ramApiRequest.vpcId)}/${Boolean(ramApiRequest.vSwitchId)}`,
    console: 'VPC + 同可用区交换机',
    match: ramApiRequest.networkType === 'VPC' && Boolean(ramApiRequest.vpcId && ramApiRequest.vSwitchId),
  },
  {
    field: 'Token (ClientToken)',
    api: ramApiRequest.token,
    console: '无（或控制台会话级）',
    match: false,
    note: `7 次 attempt 复用同一 Token=${ramApiRequest.token}；幂等可能导致重复失败订单回放`,
  },
  {
    field: 'Period/AutoRenew/BusinessInfo/CouponNo',
    api: '未传（PostPaid 正确）',
    console: '按量不传 Period',
    match: true,
  },
  {
    field: 'productType/storageType 显式字段',
    api: 'CreateInstance SDK 无此字段；由 InstanceClass 编码 Local',
    console: '经典版 LocalDisk 规格族',
    match: true,
  },
];

const officialRequired = {
  RegionId: 'YES',
  Capacity_or_InstanceClass: 'YES (至少其一)',
  ZoneId: 'NO（文档标否；VPC 场景实际应与 vSwitch 一致）',
  ChargeType: 'NO（默认 PostPaid）',
  NodeType: 'NO（经典应用 double/single）',
  InstanceType: 'NO（默认 Redis）',
  EngineVersion: 'NO（默认 5.0）',
  VpcId_VSwitchId: 'NO（VPC 时需成对）',
  Period: '仅 PrePaid 必填',
  BusinessInfo_CouponNo_SrcDBInstanceId: '否，非普通新购必填',
  Token: '否，幂等可选',
};

console.log(
  JSON.stringify(
    {
      mode: 'CREATE_REQUEST_DIFF_ONLY',
      CREATE_API_CALLED: false,
      cloudResourceId: CR,
      attempt: m.createInstanceAttemptCount ?? 0,
      success: m.createInstanceSuccessCount ?? 0,
      providerResourceId: cr.providerResourceId,
      lastError: {
        providerErrorCode: m.providerErrorCode || null,
        providerRequestId: m.providerRequestId || null,
        technicalMessage: m.technicalMessage || null,
      },
      productMapping: {
        sdk: '@alicloud/r-kvstore20150101 CreateInstance',
        product: 'Redis 开源版经典架构（非 CreateTairInstance / 非云原生 OnECS）',
        instanceClassFamily: 'redis.master.* = Local classic standard',
        notOnEcs: !String(ramApiRequest.instanceClass || '').includes('.ce'),
        nodeTypeMatchesClassic: ramApiRequest.nodeType === 'double',
      },
      ramApiRequest,
      consoleEquivalent,
      fieldDiff,
      officialRequired,
      payInsufficientBalanceNotes: [
        '官方释义：账户余额不足；另有 PaymentMethodNotFound / AccountMoneyValidateError / QuotaExceed.AfterpayInstance 等更具体码',
        '已排除：缺 AliyunBSSOrderAccess（当前 BILLING_ORDER_PERMISSION=READY）',
        '官方 FAQ：按量付费通常只需产品创建权限；包年包月才强调 BSS 订单权限',
        '可能仍为财务侧校验（可用额度占用/按量预留/财务云账号限制），而非缺请求字段',
        '可疑运维因素：同一 ClientToken 跨 7 次 attempt 幂等回放',
      ],
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
