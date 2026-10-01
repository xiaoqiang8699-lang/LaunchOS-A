import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCreateInstanceRequestPreview,
  resolveRedisCreateNodeType,
  isCloudNativeRedisClass,
} from './alibaba-cloud-redis-provider';
import { AlibabaCloudRedisProvider } from './alibaba-cloud-redis-provider';
import type { NormalizedRedisAvailableResource } from './redis-available-resource';

describe('CreateInstance request preview / OnECS mapping', () => {
  it('maps OnECS class to cloud-native nodeType MASTER_SLAVE', () => {
    assert.equal(isCloudNativeRedisClass('redis.shard.small.ce', 'OnECS'), true);
    assert.equal(resolveRedisCreateNodeType('redis.shard.small.ce', 'OnECS'), 'MASTER_SLAVE');
    const preview = buildCreateInstanceRequestPreview({
      region: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-i',
      instanceClass: 'redis.shard.small.ce',
      engineVersion: '7.0',
      storageType: 'OnECS',
      architecture: 'non_cluster',
      capacityMb: 1024,
      vpcId: 'vpc-x',
    });
    assert.equal(preview.instanceClass, 'redis.shard.small.ce');
    assert.equal(preview.engineVersion, '7.0');
    assert.equal(preview.storageType, 'OnECS');
    assert.equal(preview.nodeType, 'MASTER_SLAVE');
    assert.equal(preview.chargeType, 'PostPaid');
    assert.equal(preview.instanceType, 'Redis');
    assert.equal(preview.capacity, 1024);
  });

  it('maps Local classic class to nodeType double', () => {
    assert.equal(resolveRedisCreateNodeType('redis.master.small.default', 'Local'), 'double');
    const preview = buildCreateInstanceRequestPreview({
      region: 'cn-hangzhou',
      instanceClass: 'redis.master.small.default',
      engineVersion: '5.0',
      storageType: 'Local',
      capacityMb: 1024,
    });
    assert.equal(preview.nodeType, 'double');
    assert.equal(preview.engineVersion, '5.0');
  });

  it('checkBillingReadiness never claims sufficient balance', () => {
    const provider = new AlibabaCloudRedisProvider({ accessKey: 'a', secretKey: 'b' });
    const withPrice = provider.checkBillingReadiness({
      priceEstimate: {
        available: true,
        currency: 'CNY',
        originalPrice: '0.2',
        tradePrice: '0.2',
        discountPrice: '0',
        billingCycle: 'Hour',
        hourlyPrice: '0.2',
        priceUnit: 'CNY/Hour',
        providerRequestId: 'req',
        region: 'cn-hangzhou',
        instanceClass: 'redis.master.small.default',
        chargeType: 'PostPaid',
        minimumBalanceRequirement: 'UNKNOWN',
        checkedAt: new Date().toISOString(),
      },
    });
    assert.equal(withPrice.status, 'PRICE_AVAILABLE');
    assert.equal(withPrice.canConfirmSufficientBalance, false);
    assert.equal(withPrice.minimumBalanceRequirement, 'UNKNOWN');
    const insufficient = provider.checkBillingReadiness({
      priceEstimate: withPrice.priceEstimate,
      lastProviderErrorCode: 'PAY.INSUFFICIENT_BALANCE',
    });
    assert.equal(insufficient.status, 'BALANCE_INSUFFICIENT');
  });

  it('rejects Local + 7.0 before Create (attemptCount stays 0)', async () => {
    class Fake extends AlibabaCloudRedisProvider {
      constructor(private readonly resources: NormalizedRedisAvailableResource[]) {
        super({ accessKey: 'a', secretKey: 'b' });
      }
      override async describeAllAvailableResources() {
        return this.resources;
      }
    }
    const provider = new Fake([
      {
        engine: 'Redis',
        engineVersion: '5.0',
        instanceClass: 'redis.master.small.default',
        storageType: 'Local',
        zoneId: 'cn-hangzhou-i',
        capacityMb: 1024,
        available: true,
      },
    ]);
    await assert.rejects(
      () =>
        provider.createInstance({
          region: 'cn-hangzhou',
          zoneId: 'cn-hangzhou-i',
          instanceClass: 'redis.master.small.default',
          engineVersion: '7.0',
          storageType: 'Local',
          instanceName: 'launchos-x',
          password: 'LaunchosTest1!',
          securityIpList: '10.0.0.1',
          tier: 'DEV',
        }),
      /REDIS_SKU_NOT_AVAILABLE/,
    );
    assert.equal(provider.createInstanceAttemptCount, 0);
    assert.equal(provider.createInstanceSuccessCount, 0);
  });

  it('does not re-map resolved OnECS SKU to Local when tier alone would differ', async () => {
    class Fake extends AlibabaCloudRedisProvider {
      constructor(private readonly resources: NormalizedRedisAvailableResource[]) {
        super({ accessKey: 'a', secretKey: 'b' });
      }
      override async describeAllAvailableResources() {
        return this.resources;
      }
    }
    const provider = new Fake([
      {
        engine: 'Redis',
        engineVersion: '5.0',
        instanceClass: 'redis.master.small.default',
        storageType: 'Local',
        architecture: 'standard',
        zoneId: 'cn-hangzhou-i',
        capacityMb: 1024,
        available: true,
        editionType: 'Community',
      },
      {
        engine: 'Redis',
        engineVersion: '7.0',
        instanceClass: 'redis.shard.small.ce',
        storageType: 'OnECS',
        architecture: 'non_cluster',
        zoneId: 'cn-hangzhou-i',
        capacityMb: 1024,
        available: true,
        editionType: 'Community',
      },
    ]);
    const preview = provider.buildCreateInstanceRequestPreview({
      region: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-i',
      instanceClass: 'redis.shard.small.ce',
      engineVersion: '7.0',
      storageType: 'OnECS',
      capacityMb: 1024,
      architecture: 'non_cluster',
      instanceName: 'launchos-x',
      password: 'x',
      securityIpList: '10.0.0.1',
      tier: 'DEV',
    });
    assert.equal(preview.instanceClass, 'redis.shard.small.ce');
    assert.equal(preview.storageType, 'OnECS');
    assert.equal(preview.nodeType, 'MASTER_SLAVE');
    assert.notEqual(preview.instanceClass, 'redis.master.small.default');
  });
});
