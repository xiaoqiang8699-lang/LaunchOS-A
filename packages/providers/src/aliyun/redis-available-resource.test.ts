import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeRedisAvailableResources,
  selectRedisTierFromAvailability,
  validateRedisSkuSelection,
  type NormalizedRedisAvailableResource,
} from './redis-available-resource';

function combo(
  partial: Partial<NormalizedRedisAvailableResource> &
    Pick<NormalizedRedisAvailableResource, 'instanceClass' | 'engineVersion'>,
): NormalizedRedisAvailableResource {
  return {
    engine: 'Redis',
    available: true,
    storageType: 'Local',
    architecture: 'standard',
    capacityMb: 1024,
    zoneId: 'cn-hangzhou-i',
    editionType: 'Community',
    ...partial,
  };
}

describe('normalizeRedisAvailableResources', () => {
  it('reads camelCase response and inherits parent engineVersion', () => {
    const items = normalizeRedisAvailableResources(
      {
        availableZones: {
          availableZone: [
            {
              zoneId: 'cn-hangzhou-i',
              supportedEngines: {
                supportedEngine: [
                  {
                    engine: 'Redis',
                    supportedEditionTypes: {
                      supportedEditionType: [
                        {
                          editionType: 'Community',
                          supportedSeriesTypes: {
                            supportedSeriesType: [
                              {
                                seriesType: 'enhanced_performance_type',
                                supportedEngineVersions: {
                                  supportedEngineVersion: [
                                    {
                                      version: '5.0',
                                      supportedArchitectureTypes: {
                                        supportedArchitectureType: [
                                          {
                                            architecture: 'standard',
                                            availableResources: {
                                              availableResource: [
                                                {
                                                  instanceClass: 'redis.master.small.default',
                                                  capacity: 1024,
                                                  status: 'Available',
                                                },
                                              ],
                                            },
                                          },
                                        ],
                                      },
                                    },
                                  ],
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      'Local',
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.engineVersion, '5.0');
    assert.equal(items[0]?.instanceClass, 'redis.master.small.default');
    assert.equal(items[0]?.storageType, 'Local');
    assert.equal(items[0]?.available, true);
  });

  it('reads PascalCase response', () => {
    const items = normalizeRedisAvailableResources(
      {
        AvailableZones: {
          AvailableZone: [
            {
              ZoneId: 'cn-hangzhou-j',
              SupportedEngines: {
                SupportedEngine: [
                  {
                    Engine: 'Redis',
                    SupportedEditionTypes: {
                      SupportedEditionType: [
                        {
                          EditionType: 'Community',
                          SupportedSeriesTypes: {
                            SupportedSeriesType: [
                              {
                                SeriesType: 'share',
                                SupportedEngineVersions: {
                                  SupportedEngineVersion: [
                                    {
                                      Version: '7.0',
                                      SupportedArchitectureTypes: {
                                        SupportedArchitectureType: [
                                          {
                                            Architecture: 'non_cluster',
                                            AvailableResources: {
                                              AvailableResource: [
                                                {
                                                  InstanceClass: 'redis.shard.small.ce',
                                                  Capacity: 1024,
                                                  Status: 'Available',
                                                },
                                              ],
                                            },
                                          },
                                        ],
                                      },
                                    },
                                  ],
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      'OnECS',
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.engineVersion, '7.0');
    assert.equal(items[0]?.instanceClass, 'redis.shard.small.ce');
    assert.equal(items[0]?.storageType, 'OnECS');
  });

  it('returns empty list for empty availability', () => {
    assert.deepEqual(normalizeRedisAvailableResources({}), []);
  });
});

describe('selectRedisTierFromAvailability', () => {
  it('prefers 7.0 when SKU supports it (OnECS)', () => {
    const tiers = selectRedisTierFromAvailability([
      combo({
        storageType: 'OnECS',
        architecture: 'non_cluster',
        instanceClass: 'redis.shard.small.ce',
        engineVersion: '5.0',
        capacityMb: 1024,
      }),
      combo({
        storageType: 'OnECS',
        architecture: 'non_cluster',
        instanceClass: 'redis.shard.small.ce',
        engineVersion: '7.0',
        capacityMb: 1024,
      }),
      combo({
        storageType: 'OnECS',
        architecture: 'non_cluster',
        instanceClass: 'redis.shard.mid.ce',
        engineVersion: '7.0',
        capacityMb: 2048,
      }),
      combo({
        storageType: 'OnECS',
        architecture: 'non_cluster',
        instanceClass: 'redis.shard.large.ce',
        engineVersion: '7.0',
        capacityMb: 4096,
      }),
    ]);
    assert.equal(tiers[0]?.engineVersion, '7.0');
    assert.equal(tiers[0]?.instanceClass, 'redis.shard.small.ce');
    assert.equal(tiers[1]?.instanceClass, 'redis.shard.mid.ce');
    assert.equal(tiers[2]?.instanceClass, 'redis.shard.large.ce');
    assert.ok(!tiers[0]?.fallbackReason);
  });

  it('falls back to supported version when SKU does not support 7.0 (LocalDisk)', () => {
    const tiers = selectRedisTierFromAvailability([
      combo({
        storageType: 'Local',
        architecture: 'standard',
        instanceClass: 'redis.master.small.default',
        engineVersion: '5.0',
        capacityMb: 1024,
      }),
      combo({
        storageType: 'Local',
        architecture: 'standard',
        instanceClass: 'redis.master.mid.default',
        engineVersion: '5.0',
        capacityMb: 2048,
      }),
      combo({
        storageType: 'Local',
        architecture: 'standard',
        instanceClass: 'redis.master.stand.default',
        engineVersion: '5.0',
        capacityMb: 4096,
      }),
    ]);
    assert.equal(tiers[0]?.engineVersion, '5.0');
    assert.equal(tiers[0]?.instanceClass, 'redis.master.small.default');
    assert.equal(tiers[1]?.instanceClass, 'redis.master.mid.default');
    assert.equal(tiers[2]?.instanceClass, 'redis.master.stand.default');
    assert.equal(tiers[0]?.storageType, 'Local');
  });

  it('does not invent LocalDisk + 7.0 combo', () => {
    const tiers = selectRedisTierFromAvailability([
      combo({
        storageType: 'Local',
        instanceClass: 'redis.master.small.default',
        engineVersion: '5.0',
        capacityMb: 1024,
      }),
      combo({
        storageType: 'OnECS',
        architecture: 'non_cluster',
        instanceClass: 'redis.shard.small.ce',
        engineVersion: '7.0',
        capacityMb: 1024,
      }),
      combo({
        storageType: 'OnECS',
        architecture: 'non_cluster',
        instanceClass: 'redis.shard.mid.ce',
        engineVersion: '7.0',
        capacityMb: 2048,
      }),
    ]);
    for (const tier of tiers) {
      if (tier.storageType === 'Local') {
        assert.notEqual(tier.engineVersion, '7.0');
      }
      if (tier.instanceClass === 'redis.master.small.default') {
        assert.equal(tier.engineVersion, '5.0');
      }
    }
    // Prefer cloud-disk 7.0 tiers when available.
    assert.equal(tiers[0]?.storageType, 'OnECS');
    assert.equal(tiers[0]?.engineVersion, '7.0');
  });

  it('tiers come from real availability and mark fallback when SKUs are scarce', () => {
    const tiers = selectRedisTierFromAvailability([
      combo({
        storageType: 'OnECS',
        architecture: 'non_cluster',
        instanceClass: 'redis.shard.small.ce',
        engineVersion: '7.0',
        capacityMb: 1024,
      }),
    ]);
    assert.equal(tiers.length, 3);
    assert.equal(tiers[0]?.instanceClass, tiers[1]?.instanceClass);
    assert.equal(tiers[1]?.instanceClass, tiers[2]?.instanceClass);
    assert.match(tiers[0]?.fallbackReason || '', /可购买标准规格不足/);
  });

  it('excludes unavailable SKUs', () => {
    const tiers = selectRedisTierFromAvailability([
      combo({
        available: false,
        storageType: 'OnECS',
        architecture: 'non_cluster',
        instanceClass: 'redis.shard.xlarge.ce',
        engineVersion: '7.0',
        capacityMb: 8192,
      }),
      combo({
        storageType: 'OnECS',
        architecture: 'non_cluster',
        instanceClass: 'redis.shard.small.ce',
        engineVersion: '7.0',
        capacityMb: 1024,
      }),
      combo({
        storageType: 'OnECS',
        architecture: 'non_cluster',
        instanceClass: 'redis.shard.mid.ce',
        engineVersion: '7.0',
        capacityMb: 2048,
      }),
    ]);
    assert.ok(tiers.every((t) => t.instanceClass !== 'redis.shard.xlarge.ce'));
  });

  it('throws REDIS_SKU_NOT_AVAILABLE on empty availability', () => {
    assert.throws(
      () => selectRedisTierFromAvailability([]),
      (err: Error & { code?: string }) => err.code === 'REDIS_SKU_NOT_AVAILABLE',
    );
  });
});

describe('validateRedisSkuSelection', () => {
  const resources = [
    combo({
      storageType: 'Local',
      instanceClass: 'redis.master.small.default',
      engineVersion: '5.0',
      capacityMb: 1024,
      architecture: 'standard',
      architectureSource: 'provider',
    }),
    combo({
      storageType: 'OnECS',
      architecture: 'non_cluster',
      architectureSource: 'provider',
      instanceClass: 'redis.shard.small.ce',
      engineVersion: '7.0',
      capacityMb: 1024,
      zoneId: 'cn-hangzhou-j',
    }),
    combo({
      storageType: 'OnECS',
      architecture: 'non_cluster',
      architectureSource: 'provider',
      instanceClass: 'redis.shard.small.ce',
      engineVersion: '7.0',
      capacityMb: 1024,
      zoneId: 'cn-hangzhou-b',
    }),
  ];

  it('accepts a real LocalDisk + 5.0 combo', () => {
    const matched = validateRedisSkuSelection(resources, {
      instanceClass: 'redis.master.small.default',
      engineVersion: '5.0',
      storageType: 'Local',
      zoneId: 'cn-hangzhou-i',
    });
    assert.equal(matched.engineVersion, '5.0');
  });

  it('rejects LocalDisk + 7.0 (compatibility validation before Create)', () => {
    assert.throws(
      () =>
        validateRedisSkuSelection(resources, {
          instanceClass: 'redis.master.small.default',
          engineVersion: '7.0',
          storageType: 'Local',
        }),
      (err: Error & { code?: string }) => err.code === 'REDIS_SKU_NOT_AVAILABLE',
    );
  });

  it('accepts CloudDisk/OnECS + 7.0', () => {
    const matched = validateRedisSkuSelection(resources, {
      instanceClass: 'redis.shard.small.ce',
      engineVersion: '7.0',
      storageType: 'OnECS',
    });
    assert.equal(matched.storageType, 'OnECS');
  });

  it('accepts when zone array contains target zone', () => {
    const matched = validateRedisSkuSelection(resources, {
      instanceClass: 'redis.shard.small.ce',
      engineVersion: '7.0',
      storageType: 'OnECS',
      capacityMb: 1024,
      zoneId: 'cn-hangzhou-b',
    });
    assert.equal(matched.zoneId, 'cn-hangzhou-b');
  });

  it('accepts region-wide availability (no zoneId on rows) with candidate zone', () => {
    const regionWide = [
      combo({
        storageType: 'OnECS',
        instanceClass: 'redis.shard.small.ce',
        engineVersion: '7.0',
        capacityMb: 1024,
        zoneId: undefined,
      }),
    ];
    const matched = validateRedisSkuSelection(regionWide, {
      instanceClass: 'redis.shard.small.ce',
      engineVersion: '7.0',
      storageType: 'OnECS',
      zoneId: 'cn-hangzhou-i',
    });
    assert.equal(matched.instanceClass, 'redis.shard.small.ce');
  });

  it('does not hard-fail on inferred architecture mismatch', () => {
    const matched = validateRedisSkuSelection(resources, {
      instanceClass: 'redis.shard.small.ce',
      engineVersion: '7.0',
      storageType: 'OnECS',
      architecture: 'totally-inferred',
      requireArchitecture: false,
    });
    assert.equal(matched.instanceClass, 'redis.shard.small.ce');
  });

  it('hard-fails explicit incompatible provider architecture when required', () => {
    assert.throws(
      () =>
        validateRedisSkuSelection(resources, {
          instanceClass: 'redis.shard.small.ce',
          engineVersion: '7.0',
          storageType: 'OnECS',
          zoneId: 'cn-hangzhou-j',
          architecture: 'cluster',
          requireArchitecture: true,
        }),
      (err: Error & { code?: string; failedField?: string }) =>
        err.code === 'REDIS_SKU_NOT_AVAILABLE' && err.failedField === 'architecture',
    );
  });

  it('rejects missing class / version / storage mismatch / sold out', () => {
    assert.throws(
      () =>
        validateRedisSkuSelection(resources, {
          instanceClass: 'redis.missing',
          engineVersion: '7.0',
          storageType: 'OnECS',
        }),
      (err: Error & { failedField?: string }) => err.failedField === 'instanceClass',
    );
    assert.throws(
      () =>
        validateRedisSkuSelection(resources, {
          instanceClass: 'redis.shard.small.ce',
          engineVersion: '9.9',
          storageType: 'OnECS',
        }),
      (err: Error & { failedField?: string }) => err.failedField === 'engineVersion',
    );
    assert.throws(
      () =>
        validateRedisSkuSelection(resources, {
          instanceClass: 'redis.shard.small.ce',
          engineVersion: '7.0',
          storageType: 'Local',
        }),
      (err: Error & { failedField?: string }) => err.failedField === 'storageType',
    );
    assert.throws(
      () =>
        validateRedisSkuSelection(
          [
            combo({
              available: false,
              instanceClass: 'redis.shard.small.ce',
              engineVersion: '7.0',
              storageType: 'OnECS',
            }),
          ],
          {
            instanceClass: 'redis.shard.small.ce',
            engineVersion: '7.0',
            storageType: 'OnECS',
          },
        ),
      (err: Error & { failedField?: string }) =>
        err.failedField === 'empty' || err.failedField === 'instanceClass',
    );
  });

  it('rejects zone not in available set with failedField=zoneId', () => {
    assert.throws(
      () =>
        validateRedisSkuSelection(resources, {
          instanceClass: 'redis.shard.small.ce',
          engineVersion: '7.0',
          storageType: 'OnECS',
          capacityMb: 1024,
          zoneId: 'cn-hangzhou-i',
        }),
      (err: Error & { failedField?: string; availableZones?: string[] }) =>
        err.failedField === 'zoneId' &&
        Array.isArray(err.availableZones) &&
        err.availableZones.includes('cn-hangzhou-j'),
    );
  });
});
