import type { NetworkPlacement } from './database-provider.interface';

export type CacheInstanceStatus =
  | 'CREATING'
  | 'RUNNING'
  | 'FAILED'
  | 'DELETING'
  | 'DELETED'
  | 'LOCKED'
  | 'UNKNOWN';

export type CacheTier = 'DEV' | 'SMALL' | 'STANDARD';

export type CreateRedisInstanceInput = {
  region: string;
  zoneId?: string;
  instanceClass?: string;
  engineVersion?: string;
  /** Local (local disk) or OnECS (cloud disk). Must match the selected SKU combo. */
  storageType?: string;
  capacityMb?: number;
  architecture?: string;
  vpcId?: string;
  vSwitchId?: string;
  instanceName: string;
  password: string;
  /** Comma-separated CIDRs / IPs. Never use 0.0.0.0/0. */
  securityIpList: string;
  clientToken?: string;
  tier?: CacheTier;
};

/** Non-sensitive CreateInstance fields for dry-run / E2E preview. */
export type RedisCreateInstanceRequestPreview = {
  regionId: string;
  zoneId?: string;
  instanceClass: string;
  engineVersion: string;
  instanceType: string;
  chargeType: string;
  networkType?: string;
  /** Cloud-native (OnECS): MASTER_SLAVE | STAND_ALONE. Classic (Local): double | single. */
  nodeType?: string;
  capacity?: number;
  /** Informational — CreateInstanceRequest has no storageType/productType field; class+nodeType encode it. */
  storageType?: string;
  architecture?: string;
};

export type RedisConnectionInfo = {
  host: string;
  port: number;
  networkType: 'VPC' | 'PUBLIC' | 'UNKNOWN';
};

export type CacheAvailableSpec = {
  tier: CacheTier;
  label: string;
  instanceClass: string;
  engineVersion: string;
  storageType?: string;
  zoneId?: string;
  architecture?: string;
  capacityMb?: number;
  selectionReason?: string;
  fallbackReason?: string;
};

export type SetRedisWhitelistInput = {
  instanceId: string;
  securityIpList: string;
  securityIpGroupName?: string;
};

/** Safe price fields from Aliyun Redis DescribePrice (no secrets). */
export type RedisPriceEstimate = {
  available: boolean;
  currency: string | null;
  originalPrice: string | null;
  tradePrice: string | null;
  discountPrice: string | null;
  /** PostPaid → Hour when Aliyun returns hourly PAYG amounts; else null. */
  billingCycle: 'Hour' | 'Month' | 'UNKNOWN' | null;
  hourlyPrice: string | null;
  priceUnit: string | null;
  providerRequestId: string | null;
  region: string;
  zoneId?: string | null;
  instanceClass: string;
  engineVersion?: string | null;
  capacityMb?: number | null;
  chargeType: 'PostPaid' | 'PrePaid';
  minimumBalanceRequirement: 'UNKNOWN';
  checkedAt: string;
  rawOrderMessage?: string | null;
};

export type RedisBillingReadinessStatus =
  | 'PRICE_AVAILABLE'
  | 'BALANCE_UNKNOWN'
  | 'BALANCE_INSUFFICIENT'
  | 'PAYMENT_METHOD_MISSING'
  | 'ACCOUNT_RESTRICTED';

export type RedisBillingReadiness = {
  status: RedisBillingReadinessStatus;
  priceEstimate: RedisPriceEstimate | null;
  /** LaunchOS cannot read Aliyun cash/credit via Redis API — never claim balance is sufficient. */
  canConfirmSufficientBalance: false;
  minimumBalanceRequirement: 'UNKNOWN';
  accountBalanceReadable: false;
  unpaidOrderCheck: 'UNKNOWN' | 'NOT_INDICATED_BY_LAST_ERROR';
  unsettledBillCheck: 'UNKNOWN' | 'NOT_INDICATED_BY_LAST_ERROR';
  reason: string;
  lastProviderErrorCode?: string | null;
};

/**
 * Cloud Redis / cache provisioning port. Controllers must not call Aliyun APIs directly.
 */
export interface CacheProvider {
  readonly name: string;
  listAvailableSpecs(region: string, tier?: CacheTier): Promise<CacheAvailableSpec[]>;
  createInstance(input: CreateRedisInstanceInput): Promise<{ instanceId: string }>;
  getInstanceStatus(instanceId: string): Promise<{ status: CacheInstanceStatus; rawStatus?: string }>;
  waitUntilRunning(instanceId: string, timeoutMs?: number): Promise<void>;
  setWhitelist(input: SetRedisWhitelistInput): Promise<void>;
  getConnectionInfo(instanceId: string, preferPrivate?: boolean): Promise<RedisConnectionInfo>;
  allocatePublicConnection?(instanceId: string, port?: number): Promise<RedisConnectionInfo>;
  deleteInstance(instanceId: string): Promise<void>;
  resolveNetworkPlacement(input: {
    region?: string;
    ecsInstanceId?: string;
    serverPublicIp?: string;
  }): Promise<NetworkPlacement>;
}
