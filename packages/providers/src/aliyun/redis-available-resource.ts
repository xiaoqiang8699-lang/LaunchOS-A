/**
 * Normalize Aliyun Redis DescribeAvailableResource responses.
 * Supports camelCase / PascalCase and inherits parent engineVersion/zone.
 */

export type NormalizedRedisAvailableResource = {
  engine: string;
  engineVersion: string;
  instanceClass: string;
  architecture?: string;
  /** Set only when provider returned an architecture field (not LaunchOS-inferred). */
  architectureSource?: 'provider';
  storageType?: string;
  zoneId?: string;
  editionType?: string;
  seriesType?: string;
  capacityMb?: number;
  available: boolean;
  remark?: string;
};

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AnyRecord;
}

function pick(record: AnyRecord | null | undefined, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== '') {
      return record[key];
    }
  }
  return undefined;
}

function pickString(record: AnyRecord | null | undefined, ...keys: string[]): string | undefined {
  const value = pick(record, ...keys);
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function pickNumber(record: AnyRecord | null | undefined, ...keys: string[]): number | undefined {
  const value = pick(record, ...keys);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const nested of Object.values(record)) {
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function childArray(record: AnyRecord | null | undefined, ...keys: string[]): unknown[] {
  if (!record) return [];
  for (const key of keys) {
    const items = asArray(record[key]);
    if (items.length > 0) return items;
  }
  return [];
}

/**
 * Flatten DescribeAvailableResource body into purchasable SKU combinations.
 * `storageType` should be the request productType (Local / OnECS).
 */
export function normalizeRedisAvailableResources(
  body: unknown,
  storageType?: string,
): NormalizedRedisAvailableResource[] {
  const root = asRecord(body);
  const zones = childArray(
    asRecord(pick(root, 'availableZones', 'AvailableZones')),
    'availableZone',
    'AvailableZone',
  );
  const out: NormalizedRedisAvailableResource[] = [];

  for (const zoneRaw of zones) {
    const zone = asRecord(zoneRaw);
    const zoneId = pickString(zone, 'zoneId', 'ZoneId');
    const engines = childArray(
      asRecord(pick(zone, 'supportedEngines', 'SupportedEngines')),
      'supportedEngine',
      'SupportedEngine',
    );
    for (const engineRaw of engines) {
      const engineNode = asRecord(engineRaw);
      const engine = pickString(engineNode, 'engine', 'Engine') || 'Redis';
      const editions = childArray(
        asRecord(pick(engineNode, 'supportedEditionTypes', 'SupportedEditionTypes')),
        'supportedEditionType',
        'SupportedEditionType',
      );
      for (const editionRaw of editions) {
        const edition = asRecord(editionRaw);
        const editionType = pickString(edition, 'editionType', 'EditionType');
        const seriesList = childArray(
          asRecord(pick(edition, 'supportedSeriesTypes', 'SupportedSeriesTypes')),
          'supportedSeriesType',
          'SupportedSeriesType',
        );
        for (const seriesRaw of seriesList) {
          const series = asRecord(seriesRaw);
          const seriesType = pickString(series, 'seriesType', 'SeriesType');
          const versions = childArray(
            asRecord(pick(series, 'supportedEngineVersions', 'SupportedEngineVersions')),
            'supportedEngineVersion',
            'SupportedEngineVersion',
          );
          for (const versionRaw of versions) {
            const versionNode = asRecord(versionRaw);
            const engineVersion = pickString(
              versionNode,
              'version',
              'Version',
              'engineVersion',
              'EngineVersion',
            );
            if (!engineVersion) continue;
            const archs = childArray(
              asRecord(pick(versionNode, 'supportedArchitectureTypes', 'SupportedArchitectureTypes')),
              'supportedArchitectureType',
              'SupportedArchitectureType',
            );
            for (const archRaw of archs) {
              const arch = asRecord(archRaw);
              const architecture = pickString(
                arch,
                'architecture',
                'Architecture',
                'architectureType',
                'ArchitectureType',
              );
              const shards = childArray(
                asRecord(pick(arch, 'supportedShardNumbers', 'SupportedShardNumbers')),
                'supportedShardNumber',
                'SupportedShardNumber',
              );
              const shardNodes = shards.length > 0 ? shards : [archRaw];
              for (const shardRaw of shardNodes) {
                const shard = asRecord(shardRaw);
                const nodeTypes = childArray(
                  asRecord(pick(shard, 'supportedNodeTypes', 'SupportedNodeTypes')),
                  'supportedNodeType',
                  'SupportedNodeType',
                );
                const nodeList = nodeTypes.length > 0 ? nodeTypes : [shardRaw];
                for (const nodeRaw of nodeList) {
                  const node = asRecord(nodeRaw);
                  const resources = childArray(
                    asRecord(pick(node, 'availableResources', 'AvailableResources')),
                    'availableResource',
                    'AvailableResource',
                  );
                  for (const resourceRaw of resources) {
                    const resource = asRecord(resourceRaw);
                    const instanceClass = pickString(resource, 'instanceClass', 'InstanceClass');
                    if (!instanceClass) continue;
                    const soldOutHint = String(
                      pickString(resource, 'status', 'Status', 'available', 'Available') || '',
                    ).toLowerCase();
                    const available =
                      soldOutHint === '' ||
                      soldOutHint === 'available' ||
                      soldOutHint === 'true' ||
                      soldOutHint === '1' ||
                      (!soldOutHint.includes('sold') && !soldOutHint.includes('unavailable'));
                    out.push({
                      engine,
                      engineVersion,
                      instanceClass,
                      architecture: architecture || undefined,
                      architectureSource: architecture ? 'provider' : undefined,
                      storageType: storageType || undefined,
                      zoneId: zoneId || undefined,
                      editionType: editionType || undefined,
                      seriesType: seriesType || undefined,
                      capacityMb: pickNumber(resource, 'capacity', 'Capacity'),
                      available,
                      remark: pickString(resource, 'instanceClassRemark', 'InstanceClassRemark'),
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return out;
}

export type RedisSkuSelection = {
  instanceClass: string;
  engineVersion: string;
  storageType: string;
  zoneId?: string;
  architecture?: string;
  capacityMb?: number;
  selectionReason: string;
  fallbackReason?: string;
};

const TIER_LABEL: Record<'DEV' | 'SMALL' | 'STANDARD', string> = {
  DEV: '开发测试',
  SMALL: '小型生产',
  STANDARD: '标准生产',
};

function scoreCandidate(item: NormalizedRedisAvailableResource): number {
  let score = 0;
  // Prefer cloud disk (supports newer engines) over local disk.
  if (item.storageType === 'OnECS') score += 1000;
  if (item.storageType === 'Local') score += 100;
  // Prefer community / standard single-node styles.
  if (/community/i.test(item.editionType || '')) score += 50;
  if (/non_cluster|standard/i.test(item.architecture || '')) score += 40;
  if (/\.ce$/i.test(item.instanceClass)) score += 30;
  if (/\.y\.ee$/i.test(item.instanceClass)) score -= 20;
  if (/\.2\.ce$/i.test(item.instanceClass)) score -= 10;
  if (/with\.proxy/i.test(item.instanceClass)) score -= 40;
  if (/^redis\.master\./i.test(item.instanceClass)) score += 20;
  if (
    /^redis\.shard\.(small|mid|large)(\.ce)?$/i.test(item.instanceClass) ||
    /^redis\.shard\.(small|mid|large)\.ce$/i.test(item.instanceClass)
  ) {
    score += 25;
  }
  // Prefer newer engine when available for that exact combo.
  if (item.engineVersion === '7.0') score += 15;
  else if (item.engineVersion === '6.0') score += 10;
  else if (item.engineVersion === '5.0') score += 5;
  // Prefer smaller capacity for ranking base.
  score -= Math.min(item.capacityMb || 0, 100_000) / 1000;
  return score;
}

function preferEngineVersion(versions: string[]): string {
  if (versions.includes('7.0')) return '7.0';
  if (versions.includes('6.0')) return '6.0';
  if (versions.includes('5.0')) return '5.0';
  return versions.slice().sort().reverse()[0] || '';
}

/**
 * Pick distinct DEV/SMALL/STANDARD SKUs from real availability.
 * Never invent unsupported engineVersion/class pairs.
 */
export function selectRedisTierFromAvailability(
  resources: NormalizedRedisAvailableResource[],
  options?: { preferredZoneId?: string },
): Array<
  RedisSkuSelection & {
    tier: 'DEV' | 'SMALL' | 'STANDARD';
    label: string;
  }
> {
  const preferredZoneId = options?.preferredZoneId?.trim();
  const purchasableAll = resources.filter(
    (item) => item.available && item.instanceClass && item.engineVersion,
  );
  if (purchasableAll.length === 0) {
    throw Object.assign(new Error('REDIS_SKU_NOT_AVAILABLE: empty availability'), {
      code: 'REDIS_SKU_NOT_AVAILABLE',
    });
  }

  // Prefer SKUs purchasable in the placement zone; only fall back region-wide if zone empty.
  const inPreferredZone = preferredZoneId
    ? purchasableAll.filter((item) => item.zoneId === preferredZoneId)
    : [];
  const purchasable = inPreferredZone.length > 0 ? inPreferredZone : purchasableAll;

  // Group exact class+storage+version combos, keep best zone.
  const grouped = new Map<string, NormalizedRedisAvailableResource[]>();
  for (const item of purchasable) {
    const key = `${item.storageType || ''}::${item.instanceClass}::${item.engineVersion}`;
    const list = grouped.get(key) || [];
    list.push(item);
    grouped.set(key, list);
  }

  const uniqueCombos: NormalizedRedisAvailableResource[] = [];
  for (const list of grouped.values()) {
    const zoneMatch = preferredZoneId
      ? list.find((item) => item.zoneId === preferredZoneId)
      : undefined;
    const chosen = zoneMatch || list[0]!;
    uniqueCombos.push(chosen);
  }

  // Rank all combos; then pick increasing capacity ladders.
  const ranked = uniqueCombos
    .slice()
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || (a.capacityMb || 0) - (b.capacityMb || 0));

  // Prefer single-node / non-proxy for product tiers.
  const preferred = ranked.filter(
    (item) =>
      /^redis\.master\./i.test(item.instanceClass) ||
      (/^redis\.shard\./i.test(item.instanceClass) &&
        !/with\.proxy/i.test(item.instanceClass) &&
        /non_cluster|standard/i.test(item.architecture || 'non_cluster')),
  );
  const pool = preferred.length > 0 ? preferred : ranked;

  // Collapse by capacity to get ladder.
  const byCapacity = new Map<number, NormalizedRedisAvailableResource>();
  for (const item of pool) {
    const cap = item.capacityMb || 0;
    const existing = byCapacity.get(cap);
    if (!existing || scoreCandidate(item) > scoreCandidate(existing)) {
      // Prefer higher engine for same capacity.
      const versions = pool
        .filter((x) => x.instanceClass === item.instanceClass && x.storageType === item.storageType)
        .map((x) => x.engineVersion);
      const preferredVersion = preferEngineVersion(versions);
      const withPreferred =
        pool.find(
          (x) =>
            x.instanceClass === item.instanceClass &&
            x.storageType === item.storageType &&
            x.engineVersion === preferredVersion &&
            (x.capacityMb || 0) === cap,
        ) || item;
      byCapacity.set(cap, withPreferred);
    }
  }

  const ladder = [...byCapacity.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);

  if (ladder.length === 0) {
    throw Object.assign(new Error('REDIS_SKU_NOT_AVAILABLE: no suitable SKU'), {
      code: 'REDIS_SKU_NOT_AVAILABLE',
    });
  }

  const pickAt = (index: number) => ladder[Math.min(index, ladder.length - 1)]!;
  const selected = [
    { tier: 'DEV' as const, item: pickAt(0) },
    { tier: 'SMALL' as const, item: pickAt(1) },
    { tier: 'STANDARD' as const, item: pickAt(2) },
  ];

  const uniqueSkuKeys = new Set(
    selected.map((s) => `${s.item.storageType}::${s.item.instanceClass}::${s.item.engineVersion}`),
  );
  const fallbackReason =
    uniqueSkuKeys.size < 3
      ? `当前 region 可购买标准规格不足 3 档，${uniqueSkuKeys.size} 个真实 SKU 复用于产品档位`
      : undefined;

  return selected.map(({ tier, item }) => {
    const versionsForClass = purchasable
      .filter(
        (x) => x.instanceClass === item.instanceClass && x.storageType === item.storageType,
      )
      .map((x) => x.engineVersion);
    const preferredVersion = preferEngineVersion([...new Set(versionsForClass)]);
    const reasonParts = [
      `storage=${item.storageType || 'unknown'}`,
      `class=${item.instanceClass}`,
      `version=${item.engineVersion}`,
      item.capacityMb ? `capacityMb=${item.capacityMb}` : undefined,
      preferredVersion !== item.engineVersion
        ? `preferredVersionUnavailable=${preferredVersion}`
        : undefined,
    ].filter(Boolean);
    return {
      tier,
      label: TIER_LABEL[tier],
      instanceClass: item.instanceClass,
      engineVersion: item.engineVersion,
      storageType: item.storageType || 'Local',
      zoneId: item.zoneId,
      architecture: item.architecture,
      capacityMb: item.capacityMb,
      selectionReason: reasonParts.join(', '),
      fallbackReason,
    };
  });
}

export type RedisSkuValidationSelection = {
  region?: string;
  zoneId?: string;
  instanceClass: string;
  engineVersion: string;
  storageType?: string;
  capacityMb?: number;
  architecture?: string;
  /** When true, architecture must match a provider-returned architecture. Default false. */
  requireArchitecture?: boolean;
};

export type RedisSkuValidationDiagnosis = {
  valid: boolean;
  failedField?:
    | 'instanceClass'
    | 'engineVersion'
    | 'storageType'
    | 'capacityMb'
    | 'zoneId'
    | 'architecture'
    | 'available'
    | 'empty';
  expected?: Record<string, unknown>;
  match: {
    matchInstanceClass: boolean;
    matchEngineVersion: boolean;
    matchStorageType: boolean;
    matchCapacity: boolean;
    matchZone: boolean;
    matchArchitecture: boolean;
  };
  availableZones: string[];
  actualCandidates: Array<{
    instanceClass: string;
    engineVersion: string;
    storageType?: string;
    capacityMb?: number;
    zoneId?: string;
    architecture?: string;
    architectureSource?: string;
    available: boolean;
  }>;
  matched?: NormalizedRedisAvailableResource;
  checkedAt: string;
};

/**
 * Diagnose whether a candidate SKU is still purchasable.
 * Hard fields: instanceClass, engineVersion, storageType, capacity (when provided), zone membership.
 * Architecture is soft unless requireArchitecture=true and provider returned architecture.
 * Fingerprint equality is never used.
 */
export function diagnoseRedisSkuSelection(
  resources: NormalizedRedisAvailableResource[],
  selection: RedisSkuValidationSelection,
): RedisSkuValidationDiagnosis {
  const checkedAt = new Date().toISOString();
  const expected = {
    region: selection.region,
    zoneId: selection.zoneId,
    instanceClass: selection.instanceClass,
    engineVersion: selection.engineVersion,
    storageType: selection.storageType,
    capacityMb: selection.capacityMb,
    architecture: selection.architecture,
  };

  const purchasable = resources.filter((item) => item.available);
  if (purchasable.length === 0) {
    return {
      valid: false,
      failedField: 'empty',
      expected,
      match: {
        matchInstanceClass: false,
        matchEngineVersion: false,
        matchStorageType: false,
        matchCapacity: false,
        matchZone: false,
        matchArchitecture: false,
      },
      availableZones: [],
      actualCandidates: [],
      checkedAt,
    };
  }

  const byClass = purchasable.filter((item) => item.instanceClass === selection.instanceClass);
  const byVersion = byClass.filter((item) => item.engineVersion === selection.engineVersion);
  const byStorage = byVersion.filter(
    (item) =>
      !selection.storageType ||
      !item.storageType ||
      item.storageType === selection.storageType,
  );
  const byCapacity = byStorage.filter(
    (item) =>
      selection.capacityMb == null ||
      item.capacityMb == null ||
      item.capacityMb === selection.capacityMb,
  );

  const zonesWithCombo = [
    ...new Set(byCapacity.map((item) => item.zoneId).filter((z): z is string => Boolean(z))),
  ];
  // Region-wide: provider rows have no zoneId → any candidate zone is acceptable.
  const regionWide = byCapacity.length > 0 && zonesWithCombo.length === 0;
  const matchZone =
    !selection.zoneId ||
    regionWide ||
    zonesWithCombo.includes(selection.zoneId);

  const byZone = byCapacity.filter(
    (item) =>
      !selection.zoneId ||
      !item.zoneId ||
      item.zoneId === selection.zoneId,
  );

  const matchArchitecture = (() => {
    if (!selection.architecture) return true;
    if (!selection.requireArchitecture) return true;
    const providerArchRows = byZone.filter((item) => item.architectureSource === 'provider');
    if (providerArchRows.length === 0) return true;
    return providerArchRows.some((item) => item.architecture === selection.architecture);
  })();

  const match = {
    matchInstanceClass: byClass.length > 0,
    matchEngineVersion: byVersion.length > 0,
    matchStorageType: byStorage.length > 0,
    matchCapacity: byCapacity.length > 0,
    matchZone,
    matchArchitecture,
  };

  let failedField: RedisSkuValidationDiagnosis['failedField'];
  if (!match.matchInstanceClass) failedField = 'instanceClass';
  else if (!match.matchEngineVersion) failedField = 'engineVersion';
  else if (!match.matchStorageType) failedField = 'storageType';
  else if (!match.matchCapacity) failedField = 'capacityMb';
  else if (!match.matchZone) failedField = 'zoneId';
  else if (!match.matchArchitecture) failedField = 'architecture';

  const matched = byZone.find((item) => {
    if (selection.requireArchitecture && selection.architecture && item.architectureSource === 'provider') {
      return item.architecture === selection.architecture;
    }
    return true;
  });

  const actualCandidates = byClass.slice(0, 40).map((item) => ({
    instanceClass: item.instanceClass,
    engineVersion: item.engineVersion,
    storageType: item.storageType,
    capacityMb: item.capacityMb,
    zoneId: item.zoneId,
    architecture: item.architecture,
    architectureSource: item.architectureSource,
    available: item.available,
  }));

  return {
    valid: !failedField && Boolean(matched),
    failedField,
    expected,
    match,
    availableZones: zonesWithCombo,
    actualCandidates,
    matched,
    checkedAt,
  };
}

export function validateRedisSkuSelection(
  resources: NormalizedRedisAvailableResource[],
  selection: RedisSkuValidationSelection,
): NormalizedRedisAvailableResource {
  const diagnosis = diagnoseRedisSkuSelection(resources, selection);
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
  return diagnosis.matched;
}
