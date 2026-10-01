import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPostgresDatabaseUrl } from './database-url';
import { classifyDatabaseError, databaseErrorUserMessage } from './database-connection-errors';

describe('buildPostgresDatabaseUrl', () => {
  it('encodes special characters in password', () => {
    const url = buildPostgresDatabaseUrl({
      host: 'db.example.com',
      port: 5432,
      databaseName: 'myapp',
      username: 'user',
      password: 'p@ss:w/rd#1%',
      sslMode: 'REQUIRE',
    });
    assert.ok(url.includes('p%40ss%3Aw%2Frd%231%25'));
    assert.ok(url.includes('sslmode=require'));
    assert.ok(!url.includes('p@ss:w/rd#1%'));
  });

  it('omits sslmode for AUTO', () => {
    const url = buildPostgresDatabaseUrl({
      host: '127.0.0.1',
      port: 5432,
      databaseName: 'app',
      username: 'u',
      password: 'p',
      sslMode: 'AUTO',
    });
    assert.equal(url.includes('sslmode'), false);
  });
});

describe('classifyDatabaseError', () => {
  it('maps auth failures', () => {
    assert.equal(
      classifyDatabaseError({ code: '28P01', message: 'password authentication failed' }).code,
      'AUTH_FAILED',
    );
    assert.equal(databaseErrorUserMessage('AUTH_FAILED'), '数据库用户名或密码不正确。');
  });

  it('maps timeout and dns', () => {
    assert.equal(classifyDatabaseError({ code: 'ETIMEDOUT', message: 'timeout' }).code, 'TIMEOUT');
    assert.equal(classifyDatabaseError({ code: 'ENOTFOUND', message: 'getaddrinfo' }).code, 'DNS_ERROR');
  });
});
