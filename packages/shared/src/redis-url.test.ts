import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRedisUrl } from './redis-url';
import { classifyRedisError, redisErrorUserMessage } from './redis-connection-errors';

describe('buildRedisUrl', () => {
  it('builds no-auth url', () => {
    assert.equal(
      buildRedisUrl({ host: '127.0.0.1', port: 6379, databaseIndex: 0, tlsMode: 'DISABLE' }),
      'redis://127.0.0.1:6379/0',
    );
  });

  it('builds password-only and acl urls with encoding', () => {
    const passwordOnly = buildRedisUrl({
      host: 'redis.example.com',
      port: 6379,
      password: 'p@ss:w/rd#1%?',
      databaseIndex: 2,
      tlsMode: 'DISABLE',
    });
    assert.ok(passwordOnly.startsWith('redis://:'));
    assert.ok(passwordOnly.includes(encodeURIComponent('p@ss:w/rd#1%?')));
    assert.ok(passwordOnly.endsWith('/2'));

    const acl = buildRedisUrl({
      host: 'redis.example.com',
      port: 6380,
      username: 'default',
      password: 'p@ss',
      tlsMode: 'REQUIRE',
    });
    assert.ok(acl.startsWith('rediss://default:'));
    assert.ok(acl.includes(encodeURIComponent('p@ss')));
  });
});

describe('classifyRedisError', () => {
  it('maps auth and timeout', () => {
    assert.equal(classifyRedisError({ message: 'WRONGPASS invalid username-password pair' }).code, 'AUTH_FAILED');
    assert.equal(classifyRedisError({ code: 'ETIMEDOUT', message: 'timeout' }).code, 'TIMEOUT');
    assert.equal(redisErrorUserMessage('AUTH_FAILED'), 'Redis 用户名或密码不正确。');
  });
});
