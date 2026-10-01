import { setTimeout as delay } from 'node:timers/promises';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import KvstoreClient, {
  AllocateInstancePublicConnectionRequest,
  CreateInstanceRequest,
  DeleteInstanceRequest,
  DescribeAvailableResourceRequest,
  DescribeDBInstanceNetInfoRequest,
  DescribeInstanceAttributeRequest,
  DescribeInstancesRequest,
  DescribePriceRequest,
  ModifySecurityIpsRequest,
} from '@alicloud/r-kvstore20150101';
import type {
  CacheAvailableSpec,
  CacheInstanceStatus,
  CacheProvider,
  CacheTier,
  CreateRedisInstanceInput,
  RedisBillingReadiness,
  RedisConnectionInfo,
  RedisCreateInstanceRequestPreview,
  RedisPriceEstimate,
  SetRedisWhitelistInput,
} from '../core/cache-provider.interface';
import type { NetworkPlacement } from '../core/database-provider.interface';
import { AlibabaCloudDatabaseProvider } from './alibaba-cloud-database-provider';
import {
  normalizeRedisAvailableResources,
  selectRedisTierFromAvailability,
  diagnoseRedisSkuSelection,
  type NormalizedRedisAvailableResource,
} from './redis-available-resource';
import {
  normalizeRedisConnectionInfo,
  extractRedisInstanceAttribute,
} from './redis-response-normalize';

export type AlibabaCloudRedisProviderOptions = {
  accessKey: string;
  secretKey: string;
  region?: string;
};

const DEFAULT_WAIT_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 8_000;
const PRODUCT_TYPES = ['Local', 'OnECS'] as const;

function sanitizeWhitelist(list: string): string {
  const parts = list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((ip) => ip !== '0.0.0.0/0' && ip !== '::/0');
  return [...new Set(parts)].join(',');
}

function isAlreadyExists(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return /already|exist|duplicate|otherendpoint\.exist/i.test(text);
}

function isNotFound(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return /notfound|not found|invalidinstanceid|does not exist/i.test(text);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: string; data?: { Message?: string; Code?: string } };
    return [record.data?.Code, record.data?.Message, record.message].filter(Boolean).join(' ');
  }
  return String(error ?? '');
}

function wrapKvError(error: unknown): Error {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'REDIS_SKU_NOT_AVAILABLE'
  ) {
    const src = error as {
      failedField?: string;
      expected?: unknown;
      actualCandidates?: unknown;
      availableZones?: unknown;
      match?: unknown;
      checkedAt?: string;
    };
    const err = new Error(
      'REDIS_SKU_NOT_AVAILABLE: 当前选择的 Redis 规格暂时不可用，LaunchOS 正在重新选择可用规格。',
    );
    (err as { code?: string; cause?: unknown }).code = 'REDIS_SKU_NOT_AVAILABLE';
    (err as { cause?: unknown }).cause = error;
    (err as { failedField?: string }).failedField = src.failedField;
    (err as { expected?: unknown }).expected = src.expected;
    (err as { actualCandidates?: unknown }).actualCandidates = src.actualCandidates;
    (err as { availableZones?: unknown }).availableZones = src.availableZones;
    (err as { match?: unknown }).match = src.match;
    (err as { checkedAt?: string }).checkedAt = src.checkedAt;
    return err;
  }

  const sdk = extractSdkFieldsLocal(error);
  const rawText = errorText(error).slice(0, 800);
  const text = redactPasswordInText(rawText);
  const err = new Error(`Aliyun Redis: ${text || 'unknown error'}`);
  (err as { cause?: unknown }).cause = error;
  if (sdk.code) (err as { code?: string }).code = sdk.code;
  if (sdk.requestId) (err as { requestId?: string }).requestId = sdk.requestId;
  if (sdk.statusCode != null) (err as { statusCode?: number }).statusCode = sdk.statusCode;
  return err;
}

function redactPasswordInText(text: string): string {
  return text
    .replace(/([?&](?:Password|password|PassWord)=)[^&"'\s]*/g, '$1***')
    .replace(/([?&](?:AccessKeySecret|SecretKey|secretKey)=)[^&"'\s]*/g, '$1***');
}

function extractSdkFieldsLocal(error: unknown): {
  code: string | null;
  requestId: string | null;
  statusCode: number | null;
} {
  let cur: unknown = error;
  const seen = new Set<unknown>();
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as Record<string, unknown>;
    const data =
      rec.data && typeof rec.data === 'object'
        ? (rec.data as Record<string, unknown>)
        : null;
    const code =
      [rec.code, rec.Code, data?.Code, data?.code].find(
        (c): c is string => typeof c === 'string' && c.trim().length > 0 && c !== 'Error',
      ) || null;
    const requestId =
      [rec.requestId, rec.RequestId, data?.RequestId, data?.requestId].find(
        (r): r is string => typeof r === 'string' && r.trim().length > 0,
      ) || null;
    let statusCode: number | null = null;
    for (const s of [rec.statusCode, rec.status, data?.statusCode]) {
      if (typeof s === 'number' && Number.isFinite(s)) {
        statusCode = s;
        break;
      }
    }
    if (code || requestId || statusCode != null) {
      return { code, requestId, statusCode };
    }
    cur = rec.cause ?? null;
  }
  return { code: null, requestId: null, statusCode: null };
}

function mapStatus(raw?: string): CacheInstanceStatus {
  const s = (raw || '').toLowerCase();
  if (!s) return 'UNKNOWN';
  if (s === 'normal' || s === 'running' || s === 'active') return 'RUNNING';
  if (s.includes('creat') || s === 'changing' || s === 'inactive' || s === 'initializing') {
    return 'CREATING';
  }
  if (s.includes('delet')) return 'DELETING';
  if (s.includes('lock') || s.includes('arrear') || s.includes('released') || s === 'unavailable') {
    return 'LOCKED';
  }
  if (s.includes('fail') || s === 'error') return 'FAILED';
  return 'UNKNOWN';
}

function skuNotAvailable(message: string): Error {
  return Object.assign(new Error(`REDIS_SKU_NOT_AVAILABLE: ${message}`), {
    code: 'REDIS_SKU_NOT_AVAILABLE',
  });
}

/** Cloud-native / OnECS classes are encoded by instanceClass; CreateInstance has no productType field. */
export function isCloudNativeRedisClass(instanceClass: string, storageType?: string): boolean {
  if (storageType === 'OnECS') return true;
  if (storageType === 'Local') return false;
  return /^redis\.shard\./i.test(instanceClass) || /\.ce$/i.test(instanceClass) || /\.y\.ee$/i.test(instanceClass);
}

/**
 * Aliyun CreateInstanceRequest has no storageType/productType.
 * Cloud-native (OnECS) requires nodeType MASTER_SLAVE | STAND_ALONE.
 * Classic (Local) uses double | single.
 */
export function resolveRedisCreateNodeType(
  instanceClass: string,
  storageType?: string,
): 'MASTER_SLAVE' | 'STAND_ALONE' | 'double' | 'single' {
  return isCloudNativeRedisClass(instanceClass, storageType) ? 'MASTER_SLAVE' : 'double';
}

export function buildCreateInstanceRequestPreview(input: {
  region: string;
  zoneId?: string;
  instanceClass: string;
  engineVersion: string;
  storageType?: string;
  architecture?: string;
  capacityMb?: number;
  vpcId?: string;
}): RedisCreateInstanceRequestPreview {
  const nodeType = resolveRedisCreateNodeType(input.instanceClass, input.storageType);
  return {
    regionId: input.region,
    zoneId: input.zoneId,
    instanceClass: input.instanceClass,
    engineVersion: input.engineVersion,
    instanceType: 'Redis',
    chargeType: 'PostPaid',
    networkType: input.vpcId ? 'VPC' : undefined,
    nodeType,
    capacity: input.capacityMb,
    storageType: input.storageType,
    architecture: input.architecture,
  };
}

export class AlibabaCloudRedisProvider implements CacheProvider {
  readonly name = 'alibaba-cloud-redis';
  private readonly kv: InstanceType<typeof KvstoreClient>;
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  /** Increments immediately before SDK CreateInstance is invoked (including provider rejects). */
  createInstanceAttemptCount = 0;
  /** Increments only when CreateInstance returns an instanceId. */
  createInstanceSuccessCount = 0;
  /** @deprecated use createInstanceAttemptCount */
  get createInstanceCallCount(): number {
    return this.createInstanceAttemptCount;
  }

  constructor(options: AlibabaCloudRedisProviderOptions) {
    this.region = options.region?.trim() || 'cn-hangzhou';
    this.accessKey = options.accessKey;
    this.secretKey = options.secretKey;
    const config = new $OpenApiUtil.Config({
      accessKeyId: options.accessKey,
      accessKeySecret: options.secretKey,
    });
    config.endpoint = 'r-kvstore.aliyuncs.com';
    this.kv = new KvstoreClient(config);
  }

  async listAvailableSpecs(region: string, tier?: CacheTier): Promise<CacheAvailableSpec[]> {
    const resources = await this.describeAllAvailableResources(region);
    const selected = selectRedisTierFromAvailability(resources);
    const tiers: CacheTier[] = tier ? [tier] : ['DEV', 'SMALL', 'STANDARD'];
    return selected
      .filter((item) => tiers.includes(item.tier))
      .map((item) => ({
        tier: item.tier,
        label: item.label,
        instanceClass: item.instanceClass,
        engineVersion: item.engineVersion,
        storageType: item.storageType,
        zoneId: item.zoneId,
        architecture: item.architecture,
        capacityMb: item.capacityMb,
        selectionReason: item.selectionReason,
        fallbackReason: item.fallbackReason,
      }));
  }

  /**
   * Build non-sensitive CreateInstance preview from a fully resolved SKU.
   * Does not call CreateInstance. Rejects classic Local + 7.0.
   */
  buildCreateInstanceRequestPreview(
    input: CreateRedisInstanceInput & {
      instanceClass: string;
      engineVersion: string;
    },
  ): RedisCreateInstanceRequestPreview {
    if (
      (input.storageType === 'Local' || /^redis\.master\./i.test(input.instanceClass)) &&
      input.engineVersion === '7.0'
    ) {
      throw wrapKvError(skuNotAvailable('LocalDisk does not support engineVersion 7.0'));
    }
    return buildCreateInstanceRequestPreview({
      region: input.region,
      zoneId: input.zoneId,
      instanceClass: input.instanceClass,
      engineVersion: input.engineVersion,
      storageType: input.storageType,
      architecture: input.architecture,
      capacityMb: input.capacityMb,
      vpcId: input.vpcId,
    });
  }

  /**
   * Read-only Aliyun Redis DescribePrice. Never calls CreateInstance.
   * DescribePrice nodeType uses MASTER_SLAVE|STAND_ALONE (not classic double/single).
   */
  async getPriceEstimate(input: {
    region: string;
    zoneId?: string;
    instanceClass: string;
    engineVersion?: string;
    capacityMb?: number;
    storageType?: string;
    chargeType?: 'PostPaid' | 'PrePaid';
  }): Promise<RedisPriceEstimate> {
    const chargeType = input.chargeType || 'PostPaid';
    const checkedAt = new Date().toISOString();
    const priceNodeType = isCloudNativeRedisClass(input.instanceClass, input.storageType)
      ? 'MASTER_SLAVE'
      : 'MASTER_SLAVE';
    try {
      const response = await this.kv.describePrice(
        new DescribePriceRequest({
          regionId: input.region,
          zoneId: input.zoneId,
          orderType: 'BUY',
          chargeType,
          instanceClass: input.instanceClass,
          engineVersion: input.engineVersion,
          capacity: input.capacityMb,
          quantity: 1,
          nodeType: priceNodeType,
          orderParamOut: 'true',
        }),
      );
      const order = response.body?.order;
      const currency = order?.currency ?? null;
      const originalPrice = order?.originalAmount != null ? String(order.originalAmount) : null;
      const tradePrice = order?.tradeAmount != null ? String(order.tradeAmount) : null;
      const discountPrice = order?.discountAmount != null ? String(order.discountAmount) : null;
      const billingCycle: RedisPriceEstimate['billingCycle'] =
        chargeType === 'PostPaid' ? 'Hour' : chargeType === 'PrePaid' ? 'Month' : 'UNKNOWN';
      const unitCurrency = currency || 'UNKNOWN';
      return {
        available: Boolean(tradePrice || originalPrice),
        currency,
        originalPrice,
        tradePrice,
        discountPrice,
        billingCycle,
        hourlyPrice: chargeType === 'PostPaid' ? tradePrice || originalPrice : null,
        priceUnit:
          chargeType === 'PostPaid'
            ? `${unitCurrency}/Hour`
            : chargeType === 'PrePaid'
              ? `${unitCurrency}/Month`
              : null,
        providerRequestId: response.body?.requestId ?? null,
        region: input.region,
        zoneId: input.zoneId ?? null,
        instanceClass: input.instanceClass,
        engineVersion: input.engineVersion ?? null,
        capacityMb: input.capacityMb ?? null,
        chargeType,
        minimumBalanceRequirement: 'UNKNOWN',
        checkedAt,
        rawOrderMessage: order?.message ? String(order.message).slice(0, 200) : null,
      };
    } catch (error) {
      throw wrapKvError(error);
    }
  }

  /**
   * Billing readiness for create UX. Redis/KVStore APIs do not expose account cash/credit.
   * Never claims balance is sufficient. Does not call CreateInstance.
   */
  checkBillingReadiness(input: {
    priceEstimate: RedisPriceEstimate | null;
    lastProviderErrorCode?: string | null;
    priceErrorCode?: string | null;
  }): RedisBillingReadiness {
    const code = (input.lastProviderErrorCode || '').toUpperCase();
    const priceErr = (input.priceErrorCode || '').toUpperCase();
    const base = {
      priceEstimate: input.priceEstimate,
      canConfirmSufficientBalance: false as const,
      minimumBalanceRequirement: 'UNKNOWN' as const,
      accountBalanceReadable: false as const,
    };
    if (code.includes('PAY.INSUFFICIENT_BALANCE') || code.includes('INSUFFICIENT_BALANCE')) {
      return {
        ...base,
        status: 'BALANCE_INSUFFICIENT',
        unpaidOrderCheck: 'NOT_INDICATED_BY_LAST_ERROR',
        unsettledBillCheck: 'NOT_INDICATED_BY_LAST_ERROR',
        reason:
          '阿里云返回余额不足；LaunchOS 无法读取资金账户可用额度，也不能确认最低预留金额。' +
          (priceErr.includes('FORBIDDEN')
            ? '（同时 DescribePrice 因 RAM 权限不可用。）'
            : ''),
        lastProviderErrorCode: input.lastProviderErrorCode || null,
      };
    }
    if (priceErr.includes('FORBIDDEN') || priceErr.includes('NOTAUTHORIZED')) {
      return {
        ...base,
        status: 'BALANCE_UNKNOWN',
        unpaidOrderCheck: 'UNKNOWN',
        unsettledBillCheck: 'UNKNOWN',
        reason:
          'DescribePrice 被 RAM 拒绝或不可用；同时 Redis API 无法读取账户余额，最低预留金额为 UNKNOWN。',
        lastProviderErrorCode: input.lastProviderErrorCode || null,
      };
    }
    if (code.includes('ORDER.INST_HAS_UNSETTLED_BILLS') || code.includes('UNSETTLED')) {
      return {
        ...base,
        status: 'ACCOUNT_RESTRICTED',
        unpaidOrderCheck: 'UNKNOWN',
        unsettledBillCheck: 'UNKNOWN',
        reason: '阿里云返回未结清账单相关错误；请在费用中心处理后再创建。',
        lastProviderErrorCode: input.lastProviderErrorCode || null,
      };
    }
    if (code.includes('ORDER.ACCOUNT_STATUS_ILLEGAL') || code.includes('ACCOUNT_STATUS')) {
      return {
        ...base,
        status: 'ACCOUNT_RESTRICTED',
        unpaidOrderCheck: 'UNKNOWN',
        unsettledBillCheck: 'UNKNOWN',
        reason: '阿里云账户状态异常，暂时无法下单。',
        lastProviderErrorCode: input.lastProviderErrorCode || null,
      };
    }
    if (code.includes('CASH_BOOK_INSUFFICIENT') || code.includes('PAYMENT')) {
      return {
        ...base,
        status: 'PAYMENT_METHOD_MISSING',
        unpaidOrderCheck: 'UNKNOWN',
        unsettledBillCheck: 'UNKNOWN',
        reason: '阿里云提示支付方式或资金账户不可用。',
        lastProviderErrorCode: input.lastProviderErrorCode || null,
      };
    }
    if (input.priceEstimate?.available) {
      return {
        ...base,
        status: 'PRICE_AVAILABLE',
        unpaidOrderCheck: 'UNKNOWN',
        unsettledBillCheck: 'UNKNOWN',
        reason:
          '已获取 DescribePrice 报价，但无法验证账户余额是否满足阿里云新建按量资源校验。',
        lastProviderErrorCode: input.lastProviderErrorCode || null,
      };
    }
    return {
      ...base,
      status: 'BALANCE_UNKNOWN',
      unpaidOrderCheck: 'UNKNOWN',
      unsettledBillCheck: 'UNKNOWN',
      reason: '无法确认账户余额与最低预留要求（Redis API 不提供）。',
      lastProviderErrorCode: input.lastProviderErrorCode || null,
    };
  }

  async createInstance(input: CreateRedisInstanceInput): Promise<{ instanceId: string }> {
    const tier = input.tier || 'DEV';
    const resources = await this.describeAllAvailableResources(input.region);
    if (resources.length === 0) {
      throw wrapKvError(skuNotAvailable('empty DescribeAvailableResource'));
    }

    let instanceClass = input.instanceClass?.trim();
    let engineVersion = input.engineVersion?.trim();
    let storageType = input.storageType?.trim();
    let zoneId = input.zoneId?.trim();
    let capacityMb = input.capacityMb;
    let architecture = input.architecture?.trim();

    // Prefer caller-provided resolved SKU. Only select from availability when incomplete.
    if (!instanceClass || !engineVersion) {
      const selected = selectRedisTierFromAvailability(resources, {
        preferredZoneId: zoneId,
      }).find((item) => item.tier === tier);
      if (!selected) {
        throw wrapKvError(skuNotAvailable(`no tier selection for ${tier}`));
      }
      instanceClass = instanceClass || selected.instanceClass;
      engineVersion = engineVersion || selected.engineVersion;
      storageType = storageType || selected.storageType;
      zoneId = zoneId || selected.zoneId;
      capacityMb = capacityMb ?? selected.capacityMb;
      architecture = architecture || selected.architecture;
    } else if (!storageType) {
      const guessed = resources.find(
        (item) =>
          item.available &&
          item.instanceClass === instanceClass &&
          item.engineVersion === engineVersion,
      );
      storageType = guessed?.storageType;
      capacityMb = capacityMb ?? guessed?.capacityMb;
      architecture = architecture || guessed?.architecture;
    }

    if (!instanceClass || !engineVersion) {
      throw wrapKvError(skuNotAvailable('missing instanceClass/engineVersion'));
    }

    // Never allow LocalDisk + 7.0 into Create.
    if (
      (storageType === 'Local' || /^redis\.master\./i.test(instanceClass)) &&
      engineVersion === '7.0'
    ) {
      throw wrapKvError(skuNotAvailable('LocalDisk does not support engineVersion 7.0'));
    }

    try {
      let diagnosis = diagnoseRedisSkuSelection(resources, {
        region: input.region,
        zoneId,
        instanceClass,
        engineVersion,
        storageType,
        capacityMb,
        // architecture is informational unless explicitly required
        architecture,
        requireArchitecture: false,
      });

      // Zone mismatch: same class may be sold in other zones only.
      // Re-select a purchasable SKU for the placement zone instead of hard-failing a fingerprint.
      if (!diagnosis.valid && diagnosis.failedField === 'zoneId' && zoneId) {
        const zoneTiers = selectRedisTierFromAvailability(resources, {
          preferredZoneId: zoneId,
        });
        const adapted = zoneTiers.find((item) => item.tier === tier) || zoneTiers[0];
        if (adapted) {
          instanceClass = adapted.instanceClass;
          engineVersion = adapted.engineVersion;
          storageType = adapted.storageType;
          capacityMb = adapted.capacityMb;
          architecture = adapted.architecture;
          diagnosis = diagnoseRedisSkuSelection(resources, {
            region: input.region,
            zoneId,
            instanceClass,
            engineVersion,
            storageType,
            capacityMb,
            requireArchitecture: false,
          });
        }
      }

      if (!diagnosis.valid || !diagnosis.matched) {
        throw Object.assign(
          new Error(
            `REDIS_SKU_NOT_AVAILABLE: selected Redis combo is not purchasable (${diagnosis.failedField || 'unknown'})`,
          ),
          {
            code: 'REDIS_SKU_NOT_AVAILABLE',
            failedField: diagnosis.failedField,
            expected: diagnosis.expected,
            actualCandidates: diagnosis.actualCandidates,
            availableZones: diagnosis.availableZones,
            match: diagnosis.match,
            checkedAt: diagnosis.checkedAt,
          },
        );
      }

      zoneId = zoneId || diagnosis.matched.zoneId;
      capacityMb = capacityMb ?? diagnosis.matched.capacityMb;
      architecture = architecture || diagnosis.matched.architecture;
      storageType = storageType || diagnosis.matched.storageType;
    } catch (error) {
      throw wrapKvError(error);
    }

    const securityIPList = sanitizeWhitelist(input.securityIpList);
    if (!securityIPList) {
      throw wrapKvError(new Error('security IP list is required'));
    }

    const preview = buildCreateInstanceRequestPreview({
      region: input.region,
      zoneId,
      instanceClass,
      engineVersion,
      storageType,
      architecture,
      capacityMb,
      vpcId: input.vpcId,
    });

    this.createInstanceAttemptCount += 1;
    try {
      const response = await this.kv.createInstance(
        new CreateInstanceRequest({
          regionId: preview.regionId,
          instanceName: input.instanceName.slice(0, 64),
          instanceClass: preview.instanceClass,
          instanceType: preview.instanceType,
          engineVersion: preview.engineVersion,
          chargeType: preview.chargeType,
          password: input.password,
          vpcId: input.vpcId,
          vSwitchId: input.vSwitchId,
          zoneId: preview.zoneId,
          networkType: preview.networkType,
          nodeType: preview.nodeType,
          capacity: preview.capacity,
          token: input.clientToken?.slice(0, 64),
          securityIPList,
        }),
      );
      const instanceId =
        response.body?.instanceId ||
        (response.body as { InstanceId?: string } | undefined)?.InstanceId;
      if (!instanceId) {
        throw wrapKvError(new Error('CreateInstance returned empty instanceId'));
      }
      this.createInstanceSuccessCount += 1;
      return { instanceId };
    } catch (error) {
      throw wrapKvError(error);
    }
  }

  async getInstanceStatus(
    instanceId: string,
  ): Promise<{ status: CacheInstanceStatus; rawStatus?: string }> {
    try {
      const response = await this.kv.describeInstanceAttribute(
        new DescribeInstanceAttributeRequest({ instanceId }),
      );
      const attr = extractRedisInstanceAttribute(response.body);
      const raw =
        (attr?.instanceStatus as string | undefined) ||
        (attr?.InstanceStatus as string | undefined) ||
        undefined;
      return { status: mapStatus(raw), rawStatus: raw };
    } catch (error) {
      if (isNotFound(error)) return { status: 'DELETED' };
      throw wrapKvError(error);
    }
  }

  async waitUntilRunning(instanceId: string, timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const { status, rawStatus } = await this.getInstanceStatus(instanceId);
      if (status === 'RUNNING') return;
      if (status === 'FAILED' || status === 'DELETED' || status === 'LOCKED') {
        throw wrapKvError(new Error(`Redis entered ${rawStatus || status}`));
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw wrapKvError(new Error(`Timed out waiting for Redis ${instanceId}`));
  }

  async setWhitelist(input: SetRedisWhitelistInput): Promise<void> {
    const securityIps = sanitizeWhitelist(input.securityIpList);
    if (!securityIps) {
      throw wrapKvError(new Error('security IP list is required'));
    }
    try {
      await this.kv.modifySecurityIps(
        new ModifySecurityIpsRequest({
          instanceId: input.instanceId,
          securityIps,
          securityIpGroupName: input.securityIpGroupName || 'launchos',
          modifyMode: 'Cover',
        }),
      );
    } catch (error) {
      throw wrapKvError(error);
    }
  }

  async getConnectionInfo(
    instanceId: string,
    preferPrivate = true,
  ): Promise<RedisConnectionInfo> {
    let normalized = null as ReturnType<typeof normalizeRedisConnectionInfo>;
    try {
      const net = await this.kv.describeDBInstanceNetInfo(
        new DescribeDBInstanceNetInfoRequest({ instanceId }),
      );
      normalized = normalizeRedisConnectionInfo({
        netInfoBody: net.body,
        preferPrivate,
      });
    } catch {
      // fall through to attribute
    }
    if (!normalized?.connectionString) {
      const attr = await this.kv.describeInstanceAttribute(
        new DescribeInstanceAttributeRequest({ instanceId }),
      );
      normalized = normalizeRedisConnectionInfo({
        attributeBody: attr.body,
        preferPrivate,
      });
    }
    if (!normalized?.connectionString) {
      throw Object.assign(new Error('REDIS_CONNECTION_ENDPOINT_MISSING'), {
        code: 'REDIS_CONNECTION_ENDPOINT_MISSING',
      });
    }
    return {
      host: normalized.connectionString,
      port: normalized.port,
      networkType: normalized.networkType,
    };
  }

  async allocatePublicConnection(instanceId: string, port = 6379): Promise<RedisConnectionInfo> {
    try {
      const prefix = `r${instanceId.replace(/[^a-zA-Z0-9]/g, '').slice(-10).toLowerCase()}`;
      await this.kv.allocateInstancePublicConnection(
        new AllocateInstancePublicConnectionRequest({
          instanceId,
          connectionStringPrefix: prefix.slice(0, 40) || 'launchosredis',
          port: String(port),
        }),
      );
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw wrapKvError(error);
      }
    }
    return this.getConnectionInfo(instanceId, false);
  }

  async deleteInstance(instanceId: string): Promise<void> {
    try {
      await this.kv.deleteInstance(new DeleteInstanceRequest({ instanceId }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw wrapKvError(error);
    }
  }

  async resolveNetworkPlacement(input: {
    region?: string;
    ecsInstanceId?: string;
    serverPublicIp?: string;
  }): Promise<NetworkPlacement> {
    const dbProvider = new AlibabaCloudDatabaseProvider({
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      region: input.region || this.region,
    });
    return dbProvider.resolveNetworkPlacement(input);
  }

  async listInstancesByName(region: string, instanceName: string): Promise<string[]> {
    const response = await this.kv.describeInstances(
      new DescribeInstancesRequest({
        regionId: region,
        instanceName,
        pageSize: 50,
        pageNumber: 1,
      }),
    );
    const body = response.body as Record<string, unknown> | undefined;
    const instancesWrapper =
      (body?.instances as Record<string, unknown> | undefined) ||
      (body?.Instances as Record<string, unknown> | undefined);
    const list =
      (instancesWrapper?.KVStoreInstance as unknown[]) ||
      (instancesWrapper?.kVStoreInstance as unknown[]) ||
      (instancesWrapper?.Instance as unknown[]) ||
      [];
    const ids: string[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      const rec = item as Record<string, unknown>;
      const id = (rec.instanceId || rec.InstanceId) as string | undefined;
      const name = (rec.instanceName || rec.InstanceName) as string | undefined;
      if (id && (!instanceName || name === instanceName)) {
        ids.push(id);
      }
    }
    return [...new Set(ids)];
  }

  /**
   * Read-only availability matrix across Local + OnECS product types.
   * Never calls CreateInstance.
   */
  async describeAllAvailableResources(region: string): Promise<NormalizedRedisAvailableResource[]> {
    const all: NormalizedRedisAvailableResource[] = [];
    for (const productType of PRODUCT_TYPES) {
      try {
        const response = await this.kv.describeAvailableResource(
          new DescribeAvailableResourceRequest({
            regionId: region,
            instanceChargeType: 'PostPaid',
            productType,
            engine: 'Redis',
          }),
        );
        all.push(...normalizeRedisAvailableResources(response.body, productType));
      } catch {
        // One product type may be unsupported in a region; continue with the other.
      }
    }
    return all;
  }
}

export async function listRedisInstancesByName(
  provider: AlibabaCloudRedisProvider,
  region: string,
  instanceName: string,
): Promise<string[]> {
  return provider.listInstancesByName(region, instanceName);
}
