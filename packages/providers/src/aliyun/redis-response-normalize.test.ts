import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeRedisConnectionInfo,
  selectPreferredRedisEndpoint,
  extractRedisNetEndpoints,
} from './redis-response-normalize';

describe('normalizeRedisConnectionInfo', () => {
  it('reads camelCase NetInfo', () => {
    const info = normalizeRedisConnectionInfo({
      preferPrivate: true,
      netInfoBody: {
        netInfoItems: {
          instanceNetInfo: [
            {
              connectionString: 'r-private.redis.rds.aliyuncs.com',
              port: '6379',
              IPType: 'Private',
            },
            {
              connectionString: 'r-public.redis.rds.aliyuncs.com',
              port: 6379,
              IPType: 'Public',
            },
          ],
        },
      },
    });
    assert.equal(info?.connectionString, 'r-private.redis.rds.aliyuncs.com');
    assert.equal(info?.networkType, 'VPC');
  });

  it('reads PascalCase NetInfo', () => {
    const info = normalizeRedisConnectionInfo({
      preferPrivate: true,
      netInfoBody: {
        NetInfoItems: {
          InstanceNetInfo: [
            {
              ConnectionString: 'r-priv.redis.rds.aliyuncs.com',
              Port: '6379',
              IPType: 'Private',
            },
          ],
        },
      },
    });
    assert.equal(info?.connectionString, 'r-priv.redis.rds.aliyuncs.com');
  });

  it('falls back to PascalCase Attribute ConnectionDomain', () => {
    const info = normalizeRedisConnectionInfo({
      attributeBody: {
        Instances: {
          KVStoreInstanceAttribute: [
            {
              ConnectionDomain: 'r-attr.redis.rds.aliyuncs.com',
              Port: 6379,
              NetworkType: 'VPC',
            },
          ],
        },
      },
    });
    assert.equal(info?.connectionString, 'r-attr.redis.rds.aliyuncs.com');
  });

  it('prefers public when preferPrivate=false', () => {
    const endpoints = extractRedisNetEndpoints({
      netInfoItems: {
        instanceNetInfo: [
          { connectionString: 'priv.example', port: 6379, ipType: 'Private' },
          { connectionString: 'pub.example', port: 6379, ipType: 'Public' },
        ],
      },
    });
    const chosen = selectPreferredRedisEndpoint(endpoints, { preferPrivate: false });
    assert.equal(chosen?.connectionString, 'pub.example');
    assert.equal(chosen?.networkType, 'PUBLIC');
  });

  it('returns null when endpoint missing', () => {
    const info = normalizeRedisConnectionInfo({ netInfoBody: {}, attributeBody: {} });
    assert.equal(info, null);
  });
});
