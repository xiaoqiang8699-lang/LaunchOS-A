import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeRdsConnectionInfo,
  selectPreferredRdsEndpoint,
  extractRdsNetEndpoints,
} from './rds-response-normalize';

describe('normalizeRdsConnectionInfo', () => {
  it('reads camelCase NetInfo connectionString/port', () => {
    const info = normalizeRdsConnectionInfo({
      netInfoBody: {
        DBInstanceNetInfos: {
          DBInstanceNetInfo: [
            {
              connectionString: 'pgm-camel.pg.rds.aliyuncs.com',
              port: '5432',
              IPType: 'Private',
            },
          ],
        },
      },
      preferPrivate: true,
    });
    assert.equal(info?.connectionString, 'pgm-camel.pg.rds.aliyuncs.com');
    assert.equal(info?.port, 5432);
    assert.equal(info?.networkType, 'VPC');
  });

  it('reads PascalCase NetInfo ConnectionString/Port', () => {
    const info = normalizeRdsConnectionInfo({
      netInfoBody: {
        DBInstanceNetInfos: {
          DBInstanceNetInfo: [
            {
              ConnectionString: 'pgm-pascal.pg.rds.aliyuncs.com',
              Port: '5432',
              IPType: 'Private',
            },
          ],
        },
      },
      preferPrivate: true,
    });
    assert.equal(info?.connectionString, 'pgm-pascal.pg.rds.aliyuncs.com');
    assert.equal(info?.port, 5432);
    assert.equal(info?.networkType, 'VPC');
  });

  it('falls back to camelCase Attribute', () => {
    const info = normalizeRdsConnectionInfo({
      netInfoBody: { DBInstanceNetInfos: { DBInstanceNetInfo: [] } },
      attributeBody: {
        items: {
          DBInstanceAttribute: [
            {
              connectionString: 'pgm-attr-camel.pg.rds.aliyuncs.com',
              port: 5432,
            },
          ],
        },
      },
    });
    assert.equal(info?.connectionString, 'pgm-attr-camel.pg.rds.aliyuncs.com');
    assert.equal(info?.port, 5432);
  });

  it('falls back to PascalCase Attribute', () => {
    const info = normalizeRdsConnectionInfo({
      netInfoBody: { DBInstanceNetInfos: { DBInstanceNetInfo: [] } },
      attributeBody: {
        Items: {
          DBInstanceAttribute: [
            {
              ConnectionString: 'pgm-attr-pascal.pg.rds.aliyuncs.com',
              Port: '5432',
            },
          ],
        },
      },
    });
    assert.equal(info?.connectionString, 'pgm-attr-pascal.pg.rds.aliyuncs.com');
    assert.equal(info?.port, 5432);
  });

  it('prefers private/VPC over public', () => {
    const endpoints = extractRdsNetEndpoints({
      DBInstanceNetInfos: {
        DBInstanceNetInfo: [
          {
            connectionString: 'pgm-public.pg.rds.aliyuncs.com',
            port: '5432',
            IPType: 'Public',
          },
          {
            connectionString: 'pgm-private.pg.rds.aliyuncs.com',
            port: '5432',
            IPType: 'Private',
            VPCId: 'vpc-same',
          },
        ],
      },
    });
    const chosen = selectPreferredRdsEndpoint(endpoints, {
      preferPrivate: true,
      preferredVpcId: 'vpc-same',
    });
    assert.equal(chosen?.connectionString, 'pgm-private.pg.rds.aliyuncs.com');
    assert.equal(chosen?.networkType, 'VPC');
  });

  it('returns null when endpoint missing', () => {
    const info = normalizeRdsConnectionInfo({
      netInfoBody: { DBInstanceNetInfos: { DBInstanceNetInfo: [{}] } },
      attributeBody: { items: { DBInstanceAttribute: [{}] } },
    });
    assert.equal(info, null);
  });

  it('does not include credentials in normalized output', () => {
    const info = normalizeRdsConnectionInfo({
      netInfoBody: {
        DBInstanceNetInfos: {
          DBInstanceNetInfo: [
            {
              connectionString: 'pgm-safe.pg.rds.aliyuncs.com',
              port: '5432',
              IPType: 'Private',
              password: 'should-not-leak',
              accountPassword: 'should-not-leak',
            },
          ],
        },
      },
    });
    assert.ok(info);
    assert.equal('password' in info!, false);
    assert.equal(JSON.stringify(info).includes('should-not-leak'), false);
  });
});
