/**
 * Normalize Aliyun RDS OpenAPI response fields.
 * Current @alicloud/rds20140815 often returns camelCase; older samples use PascalCase.
 */

export type NormalizedRdsNetEndpoint = {
  connectionString: string;
  port: number;
  connectionStringType?: string;
  ipType?: string;
  ipAddress?: string;
  vpcId?: string;
  vSwitchId?: string;
};

export type NormalizedRdsConnectionInfo = {
  connectionString: string;
  port: number;
  connectionStringType?: string;
  networkType: 'VPC' | 'PUBLIC' | 'UNKNOWN';
};

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AnyRecord;
}

function pickString(record: AnyRecord | null | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function pickNumber(record: AnyRecord | null | undefined, ...keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function pickArray(record: AnyRecord | null | undefined, ...keys: string[]): unknown[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Read one net-info item with camelCase / PascalCase compatibility. */
export function normalizeRdsNetEndpoint(raw: unknown): NormalizedRdsNetEndpoint | null {
  const item = asRecord(raw);
  if (!item) return null;
  const connectionString = pickString(item, 'connectionString', 'ConnectionString');
  if (!connectionString) return null;
  const port = pickNumber(item, 'port', 'Port') ?? 5432;
  return {
    connectionString,
    port,
    connectionStringType: pickString(item, 'connectionStringType', 'ConnectionStringType'),
    ipType: pickString(item, 'ipType', 'IPType', 'IpType'),
    ipAddress: pickString(item, 'ipAddress', 'IPAddress', 'IpAddress'),
    vpcId: pickString(item, 'vpcId', 'VPCId', 'VpcId'),
    vSwitchId: pickString(item, 'vSwitchId', 'VSwitchId'),
  };
}

/** Extract net-info list from DescribeDBInstanceNetInfo body. */
export function extractRdsNetEndpoints(body: unknown): NormalizedRdsNetEndpoint[] {
  const root = asRecord(body);
  const netInfosWrapper =
    asRecord(root?.DBInstanceNetInfos) ||
    asRecord(root?.dBInstanceNetInfos) ||
    asRecord(root?.dbInstanceNetInfos);
  const items = pickArray(
    netInfosWrapper,
    'DBInstanceNetInfo',
    'dBInstanceNetInfo',
    'dbInstanceNetInfo',
  );
  // Some SDK shapes nest under body.DBInstanceNetInfos directly as array
  const direct = pickArray(root, 'DBInstanceNetInfos', 'dBInstanceNetInfos', 'dbInstanceNetInfos');
  const rawItems = items.length > 0 ? items : direct;
  return rawItems
    .map((item) => normalizeRdsNetEndpoint(item))
    .filter((item): item is NormalizedRdsNetEndpoint => Boolean(item));
}

/**
 * Prefer VPC/private endpoint; public only as fallback.
 * Optionally bias toward endpoints in the same VPC as the target ECS.
 */
export function selectPreferredRdsEndpoint(
  endpoints: NormalizedRdsNetEndpoint[],
  options?: { preferPrivate?: boolean; preferredVpcId?: string },
): NormalizedRdsConnectionInfo | null {
  if (endpoints.length === 0) return null;
  const preferPrivate = options?.preferPrivate !== false;
  const preferredVpcId = options?.preferredVpcId?.trim();

  const isPrivate = (ep: NormalizedRdsNetEndpoint) => {
    const t = (ep.ipType || ep.connectionStringType || '').toLowerCase();
    return t === 'private' || t === 'inner' || t.includes('vpc');
  };
  const isPublic = (ep: NormalizedRdsNetEndpoint) => {
    const t = (ep.ipType || ep.connectionStringType || '').toLowerCase();
    return t === 'public';
  };

  const privateEps = endpoints.filter(isPrivate);
  const publicEps = endpoints.filter(isPublic);
  const rest = endpoints.filter((ep) => !isPrivate(ep) && !isPublic(ep));

  const rank = (list: NormalizedRdsNetEndpoint[]) => {
    if (!preferredVpcId) return list[0] || null;
    const sameVpc = list.find((ep) => ep.vpcId === preferredVpcId);
    return sameVpc || list[0] || null;
  };

  const chosen = preferPrivate
    ? rank(privateEps) || rank(rest) || rank(publicEps)
    : rank(publicEps) || rank(privateEps) || rank(rest);

  if (!chosen) return null;
  return {
    connectionString: chosen.connectionString,
    port: chosen.port,
    connectionStringType: chosen.connectionStringType,
    networkType: isPrivate(chosen) ? 'VPC' : isPublic(chosen) ? 'PUBLIC' : 'UNKNOWN',
  };
}

/** Normalize Attribute ConnectionString / Port fallback. */
export function normalizeRdsAttributeConnection(
  attribute: unknown,
): NormalizedRdsConnectionInfo | null {
  const item = asRecord(attribute);
  if (!item) return null;
  const connectionString = pickString(item, 'connectionString', 'ConnectionString');
  if (!connectionString) return null;
  const port = pickNumber(item, 'port', 'Port') ?? 5432;
  return {
    connectionString,
    port,
    networkType: 'UNKNOWN',
  };
}

export function extractRdsAttribute(
  body: unknown,
): AnyRecord | null {
  const root = asRecord(body);
  const itemsWrapper =
    asRecord(root?.items) || asRecord(root?.Items);
  const list = pickArray(
    itemsWrapper,
    'DBInstanceAttribute',
    'dBInstanceAttribute',
    'dbInstanceAttribute',
  );
  return asRecord(list[0]) || null;
}

export function pickRdsName(raw: unknown, ...keys: string[]): string | undefined {
  const record = asRecord(raw);
  return pickString(record, ...keys);
}

/** Build the unified connection info used by Provider code. */
export function normalizeRdsConnectionInfo(input: {
  netInfoBody?: unknown;
  attributeBody?: unknown;
  preferPrivate?: boolean;
  preferredVpcId?: string;
}): NormalizedRdsConnectionInfo | null {
  const fromNet = selectPreferredRdsEndpoint(extractRdsNetEndpoints(input.netInfoBody), {
    preferPrivate: input.preferPrivate,
    preferredVpcId: input.preferredVpcId,
  });
  if (fromNet) return fromNet;
  return normalizeRdsAttributeConnection(extractRdsAttribute(input.attributeBody));
}
