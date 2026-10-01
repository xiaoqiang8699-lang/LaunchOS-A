import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyCloudDatabaseError,
  cloudDatabaseErrorUserMessage,
  sanitizeDatabaseName,
} from './database-provision';

describe('sanitizeDatabaseName', () => {
  it('prefixes and cleans slug', () => {
    assert.equal(sanitizeDatabaseName('My App!'), 'launchos_my_app');
  });
});

describe('classifyCloudDatabaseError', () => {
  it('maps permission errors', () => {
    assert.equal(
      classifyCloudDatabaseError(new Error('Forbidden.RAM')).code,
      'PERMISSION_DENIED',
    );
    assert.equal(
      classifyCloudDatabaseError(new Error('Unauthorized')).code,
      'PERMISSION_DENIED',
    );
    assert.equal(
      classifyCloudDatabaseError(new Error('NoPermission')).code,
      'PERMISSION_DENIED',
    );
    assert.equal(
      classifyCloudDatabaseError(new Error('RamPermissionDenied')).code,
      'PERMISSION_DENIED',
    );
    assert.equal(
      classifyCloudDatabaseError(new Error('ServiceLinkedRole.NotExist')).code,
      'PERMISSION_DENIED',
    );
  });

  it('maps RDS_CONNECTION_ENDPOINT_MISSING', () => {
    assert.equal(
      classifyCloudDatabaseError(
        Object.assign(new Error('Aliyun RDS: RDS_CONNECTION_ENDPOINT_MISSING'), {
          code: 'RDS_CONNECTION_ENDPOINT_MISSING',
        }),
      ).code,
      'RDS_CONNECTION_ENDPOINT_MISSING',
    );
    assert.equal(
      classifyCloudDatabaseError(new Error('RDS connection endpoint missing')).code,
      'RDS_CONNECTION_ENDPOINT_MISSING',
    );
  });
});

describe('cloudDatabaseErrorUserMessage', () => {
  it('special-cases service linked role', () => {
    assert.equal(
      cloudDatabaseErrorUserMessage(
        'PROVIDER_ERROR',
        'ServiceLinkedRole.NotExist: Service linked role for RDS PostgreSQL not exist',
      ),
      '阿里云 PostgreSQL 服务授权尚未完成。',
    );
  });

  it('uses friendly copy for missing endpoint', () => {
    assert.equal(
      cloudDatabaseErrorUserMessage('RDS_CONNECTION_ENDPOINT_MISSING'),
      '数据库连接地址暂时未准备好，请稍后重试。',
    );
  });
});
