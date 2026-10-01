/**
 * Normalize Aliyun Redis (R-kvstore) OpenAPI response fields.
 * Supports both camelCase and PascalCase.
 */

export type NormalizedRedisEndpoint = {
  connectionString: string;
  port: number;
  ipType?: string;
  vpcId?: string;
};

export type NormalizedRedisConnectionInfo = {
  connectionString: string;
  port: number;
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

export function normalizeRedisNetEndpoint(raw: unknown): NormalizedRedisEndpoint | null {
  const item = asRecord(raw);
  if (!item) return null;
  const connectionString = pickString(
    item,
    'connectionString',
    'ConnectionString',
    'connectionDomain',
    'ConnectionDomain',
    'IPAddress',
    'ipAddress',
  );
  if (!connectionString) return null;
  const port = pickNumber(item, 'port', 'Port') ?? 6379;
  return {
    connectionString,
    port,
    ipType: pickString(item, 'ipType', 'IPType', 'IpType', 'DBInstanceNetType', 'dBInstanceNetType'),
    vpcId: pickString(item, 'vpcId', 'VPCId', 'VpcId'),
  };
}

export function extractRedisNetEndpoints(body: unknown): NormalizedRedisEndpoint[] {
  const root = asRecord(body);
  const wrapper =
    asRecord(root?.netInfoItems) ||
    asRecord(root?.NetInfoItems) ||
    asRecord(root?.DBInstanceNetInfos) ||
    asRecord(root?.dBInstanceNetInfos);
  const items = pickArray(
    wrapper,
    'instanceNetInfo',
    'InstanceNetInfo',
    'DBInstanceNetInfo',
    'dBInstanceNetInfo',
  );
  const direct = pickArray(root, 'netInfoItems', 'NetInfoItems');
  const raw = items.length > 0 ? items : direct;
  return raw
    .map((item) => normalizeRedisNetEndpoint(item))
    .filter((item): item is NormalizedRedisEndpoint => Boolean(item));
}

export function selectPreferredRedisEndpoint(
  endpoints: NormalizedRedisEndpoint[],
  options?: { preferPrivate?: boolean },
): NormalizedRedisConnectionInfo | null {
  if (endpoints.length === 0) return null;
  const preferPrivate = options?.preferPrivate !== false;
  const isPrivate = (ep: NormalizedRedisEndpoint) => {
    const t = (ep.ipType || '').toLowerCase();
    return t === 'private' || t === 'inner' || t.includes('vpc') || t === '0';
  };
  const isPublic = (ep: NormalizedRedisEndpoint) => {
    const t = (ep.ipType || '').toLowerCase();
    return t === 'public' || t === '1';
  };
  const privateEps = endpoints.filter(isPrivate);
  const publicEps = endpoints.filter(isPublic);
  const rest = endpoints.filter((ep) => !isPrivate(ep) && !isPublic(ep));
  const chosen = preferPrivate
    ? privateEps[0] || rest[0] || publicEps[0]
    : publicEps[0] || privateEps[0] || rest[0];
  if (!chosen) return null;
  return {
    connectionString: chosen.connectionString,
    port: chosen.port,
    networkType: isPrivate(chosen) ? 'VPC' : isPublic(chosen) ? 'PUBLIC' : 'UNKNOWN',
  };
}

export function extractRedisInstanceAttribute(body: unknown): AnyRecord | null {
  const root = asRecord(body);
  const list = pickArray(
    asRecord(root?.instances) || asRecord(root?.Instances) || root,
    'KVStoreInstanceAttribute',
    'kVStoreInstanceAttribute',
    'DBInstanceAttribute',
    'Instance',
  );
  if (list[0]) return asRecord(list[0]);
  // Some responses return a single Instances object
  const single =
    asRecord(root?.instances) ||
    asRecord(root?.Instances) ||
    asRecord(root?.instance) ||
    asRecord(root?.Instance);
  if (single && (single.connectionDomain || single.ConnectionDomain || single.instanceId || single.InstanceId)) {
    return single;
  }
  return null;
}

export function normalizeRedisAttributeConnection(
  attribute: unknown,
): NormalizedRedisConnectionInfo | null {
  const item = asRecord(attribute);
  if (!item) return null;
  const connectionString = pickString(
    item,
    'connectionDomain',
    'ConnectionDomain',
    'privateConnectionDomain',
    'PrivateConnectionDomain',
    'connectionString',
    'ConnectionString',
  );
  if (!connectionString) return null;
  const port = pickNumber(item, 'port', 'Port') ?? 6379;
  const networkTypeRaw = pickString(item, 'networkType', 'NetworkType') || '';
  const networkType =
    /vpc/i.test(networkTypeRaw) ? 'VPC' : /classic|public/i.test(networkTypeRaw) ? 'PUBLIC' : 'UNKNOWN';
  return { connectionString, port, networkType };
}

export function normalizeRedisConnectionInfo(input: {
  netInfoBody?: unknown;
  attributeBody?: unknown;
  preferPrivate?: boolean;
}): NormalizedRedisConnectionInfo | null {
  const fromNet = selectPreferredRedisEndpoint(extractRedisNetEndpoints(input.netInfoBody), {
    preferPrivate: input.preferPrivate,
  });
  if (fromNet) return fromNet;
  const attr =
    extractRedisInstanceAttribute(input.attributeBody) ||
    asRecord(
      pickArray(
        asRecord(asRecord(input.attributeBody)?.instances) ||
          asRecord(asRecord(input.attributeBody)?.Instances),
        'KVStoreInstanceAttribute',
        'kVStoreInstanceAttribute',
      )[0],
    );
  return normalizeRedisAttributeConnection(attr);
}
