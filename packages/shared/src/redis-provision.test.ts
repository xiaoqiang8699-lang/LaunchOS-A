import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  advanceRedisCreateGeneration,
  bumpRedisCreateGenerationCounters,
  classifyCloudRedisError,
  classifyRedisCreateFailureKind,
  cloudRedisErrorUserMessage,
  generateManagedRedisPassword,
  parseAliyunRedisProviderError,
  sanitizeRedisInstanceName,
  shouldRotateRedisCreateClientToken,
} from './redis-provision.js';

describe('redis-provision helpers', () => {
  it('sanitizeRedisInstanceName prefixes launchos', () => {
    assert.equal(sanitizeRedisInstanceName('Demo App'), 'launchos-demo-app');
  });

  it('generateManagedRedisPassword meets complexity', () => {
    const password = generateManagedRedisPassword();
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[0-9]/);
    assert.match(password, /[!@#$%^&*_+=-]/);
    assert.ok(password.length >= 8 && password.length <= 32);
  });

  it('classifies locked provider state', () => {
    const result = classifyCloudRedisError(new Error('IncorrectDBInstanceLockMode arrears'));
    assert.equal(result.code, 'PROVIDER_LOCKED');
  });

  it('classifies ambiguous reconcile', () => {
    const result = classifyCloudRedisError(
      Object.assign(new Error('multiple redis'), { code: 'REDIS_RECONCILE_AMBIGUOUS' }),
    );
    assert.equal(result.code, 'REDIS_RECONCILE_AMBIGUOUS');
  });

  it('classifies PAY.INSUFFICIENT_BALANCE as billing error', () => {
    const msg =
      'Aliyun Redis: PAY.INSUFFICIENT_BALANCE: code: 400, User attempted to create a new order.but user account balance is insufficient. request id: 01A0AD67-C4D9-5187-B5E8-424CE968FF53';
    const result = classifyCloudRedisError(new Error(msg));
    assert.equal(result.code, 'REDIS_BILLING_INSUFFICIENT_BALANCE');
    assert.equal(result.retryableAfterUserAction, true);
    assert.equal(result.providerErrorCode, 'PAY.INSUFFICIENT_BALANCE');
    assert.equal(result.providerRequestId, '01A0AD67-C4D9-5187-B5E8-424CE968FF53');
    assert.equal(result.httpStatus, 400);
    assert.equal(
      cloudRedisErrorUserMessage(result.code, msg),
      '阿里云账户余额不足，暂时无法创建 Redis，请先充值后继续。',
    );
  });

  it('does not treat order.but prose as provider error code', () => {
    const parsed = parseAliyunRedisProviderError(
      new Error(
        'PAY.INSUFFICIENT_BALANCE: code: 400, User attempted to create a new order.but user account balance is insufficient. request id: ABC',
      ),
    );
    assert.equal(parsed.providerErrorCode, 'PAY.INSUFFICIENT_BALANCE');
    assert.notEqual(parsed.providerErrorCode, 'order.but');
  });

  it('does not treat URL query EngineVersion= as provider error code', () => {
    const msg =
      'Aliyun Redis: ConnectTimeout: Connect HTTPS://r-kvstore.aliyuncs.com/?Capacity=1024&EngineVersion=5.0&InstanceClass=redis.master.small.default&Password=SECRET&Token=op_abc failed.';
    const parsed = parseAliyunRedisProviderError(new Error(msg));
    assert.equal(parsed.providerErrorCode, 'ConnectTimeout');
    assert.notEqual(parsed.providerErrorCode, 'EngineVersion');
    assert.ok(!parsed.providerErrorMessage.includes('SECRET'));
    assert.ok(parsed.providerErrorMessage.includes('Password=***'));
  });

  it('prefers SDK code/requestId/statusCode over message scrape', () => {
    const err = Object.assign(new Error('ignored EngineVersion=5.0 in url'), {
      code: 'EngineVersion.NotSupportOnLocalDisk',
      requestId: 'REQ-123',
      statusCode: 400,
    });
    const parsed = parseAliyunRedisProviderError(err);
    assert.equal(parsed.providerErrorCode, 'EngineVersion.NotSupportOnLocalDisk');
    assert.equal(parsed.providerRequestId, 'REQ-123');
    assert.equal(parsed.httpStatus, 400);
    assert.equal(
      classifyRedisCreateFailureKind({
        providerErrorCode: parsed.providerErrorCode,
        httpStatus: parsed.httpStatus,
        technicalMessage: parsed.providerErrorMessage,
      }),
      'TERMINAL_REJECTION',
    );
  });

  it('HTTP 4xx business code is never classified as timeout', () => {
    assert.equal(
      classifyRedisCreateFailureKind({
        providerErrorCode: 'Forbidden.RAM',
        httpStatus: 403,
        technicalMessage: 'Forbidden.RAM no permission',
      }),
      'TERMINAL_REJECTION',
    );
    const classified = classifyCloudRedisError(
      Object.assign(new Error('Forbidden.RAM: code: 403, no permission. request id: X'), {
        code: 'Forbidden.RAM',
        statusCode: 403,
        requestId: 'X',
      }),
    );
    assert.notEqual(classified.code, 'PROVIDER_TIMEOUT');
  });
});

describe('CreateInstance ClientToken lifecycle', () => {
  it('timeout → UNKNOWN_RESULT → token does not rotate', () => {
    const kind = classifyRedisCreateFailureKind({
      errorCode: 'PROVIDER_TIMEOUT',
      technicalMessage: 'ReadTimeout connecting to redis.aliyuncs.com',
    });
    assert.equal(kind, 'UNKNOWN_RESULT');
    const decision = shouldRotateRedisCreateClientToken({
      providerResourceId: null,
      reconcileMatchCount: 0,
      failureKind: kind,
      userRequestedRetry: true,
    });
    assert.equal(decision.rotate, false);
  });

  it('unknown socket reset → token does not rotate', () => {
    const kind = classifyRedisCreateFailureKind({
      technicalMessage: 'socket reset by peer / ECONNRESET',
    });
    assert.equal(kind, 'UNKNOWN_RESULT');
    assert.equal(
      shouldRotateRedisCreateClientToken({
        providerResourceId: null,
        reconcileMatchCount: 0,
        failureKind: kind,
        userRequestedRetry: true,
      }).rotate,
      false,
    );
  });

  it('terminal PAY rejection + reconcile=0 + user retry → new token', () => {
    const kind = classifyRedisCreateFailureKind({
      errorCode: 'REDIS_BILLING_INSUFFICIENT_BALANCE',
      providerErrorCode: 'PAY.INSUFFICIENT_BALANCE',
    });
    assert.equal(kind, 'TERMINAL_REJECTION');
    const decision = shouldRotateRedisCreateClientToken({
      providerResourceId: null,
      reconcileMatchCount: 0,
      failureKind: kind,
      userRequestedRetry: true,
    });
    assert.equal(decision.rotate, true);
    const advanced = advanceRedisCreateGeneration({
      currentOperationId: 'op_12b187589f6e01b6',
      totalAttemptCount: 7,
      totalSuccessCount: 0,
      terminalErrorCode: 'PAY.INSUFFICIENT_BALANCE',
      lastRequestId: 'req-old',
      now: '2026-09-17T00:00:00.000Z',
    });
    assert.equal(advanced.createGeneration, 2);
    assert.notEqual(advanced.operationId, 'op_12b187589f6e01b6');
    assert.match(advanced.operationId, /^op_[a-f0-9]{16}$/);
    assert.equal(advanced.previousOperationId, 'op_12b187589f6e01b6');
    assert.equal(advanced.createGenerations.length, 2);
    assert.equal(advanced.createGenerations[0]!.generation, 1);
    assert.equal(advanced.createGenerations[0]!.operationId, 'op_12b187589f6e01b6');
    assert.equal(advanced.createGenerations[0]!.attemptCount, 7);
    assert.equal(advanced.createGenerations[0]!.terminalErrorCode, 'PAY.INSUFFICIENT_BALANCE');
    assert.equal(advanced.createGenerations[0]!.closedAt, '2026-09-17T00:00:00.000Z');
    assert.equal(advanced.createGenerations[1]!.generation, 2);
    assert.equal(advanced.createGenerations[1]!.attemptCount, 0);
    assert.equal(advanced.createGenerations[1]!.successCount, 0);
    assert.equal(advanced.createGenerations[1]!.closedAt, null);
  });

  it('Forbidden.RAM + reconcile=0 + user retry → new token', () => {
    const kind = classifyRedisCreateFailureKind({
      providerErrorCode: 'Forbidden.RAM',
      technicalMessage: 'Forbidden.RAM: no permission',
    });
    assert.equal(kind, 'TERMINAL_REJECTION');
    assert.equal(
      shouldRotateRedisCreateClientToken({
        providerResourceId: null,
        reconcileMatchCount: 0,
        failureKind: kind,
        userRequestedRetry: true,
      }).rotate,
      true,
    );
  });

  it('providerResourceId already set → never rotate create token', () => {
    assert.equal(
      shouldRotateRedisCreateClientToken({
        providerResourceId: 'r-bpxxxxx',
        reconcileMatchCount: 0,
        failureKind: 'TERMINAL_REJECTION',
        userRequestedRetry: true,
      }).rotate,
      false,
    );
    assert.equal(
      shouldRotateRedisCreateClientToken({
        providerResourceId: null,
        createInstanceCompleted: true,
        reconcileMatchCount: 0,
        failureKind: 'TERMINAL_REJECTION',
        userRequestedRetry: true,
      }).rotate,
      false,
    );
  });

  it('reconcile=1 → claim, do not rotate token', () => {
    assert.equal(
      shouldRotateRedisCreateClientToken({
        providerResourceId: null,
        reconcileMatchCount: 1,
        failureKind: 'TERMINAL_REJECTION',
        userRequestedRetry: true,
      }).reason,
      'reconcile_claim',
    );
  });

  it('reconcile>1 → ambiguous, do not rotate', () => {
    assert.equal(
      shouldRotateRedisCreateClientToken({
        providerResourceId: null,
        reconcileMatchCount: 2,
        failureKind: 'TERMINAL_REJECTION',
        userRequestedRetry: true,
      }).reason,
      'reconcile_ambiguous',
    );
  });

  it('old generation audit is preserved across advance', () => {
    const first = advanceRedisCreateGeneration({
      currentOperationId: 'op_old',
      totalAttemptCount: 7,
      totalSuccessCount: 0,
      terminalErrorCode: 'PAY.INSUFFICIENT_BALANCE',
    });
    const second = advanceRedisCreateGeneration({
      generations: first.createGenerations,
      currentOperationId: first.operationId,
      closedAttemptCount: 1,
      closedSuccessCount: 0,
      terminalErrorCode: 'Forbidden.RAM',
    });
    assert.equal(second.createGeneration, 3);
    assert.equal(second.createGenerations.length, 3);
    assert.equal(second.createGenerations[0]!.operationId, 'op_old');
    assert.equal(second.createGenerations[0]!.terminalErrorCode, 'PAY.INSUFFICIENT_BALANCE');
    assert.equal(second.createGenerations[1]!.operationId, first.operationId);
    assert.equal(second.createGenerations[1]!.terminalErrorCode, 'Forbidden.RAM');
    assert.equal(second.createGenerations[1]!.attemptCount, 1);
    assert.notEqual(second.operationId, first.operationId);
  });

  it('bump generation counters without dropping prior generations', () => {
    const advanced = advanceRedisCreateGeneration({
      currentOperationId: 'op_a',
      totalAttemptCount: 7,
      totalSuccessCount: 0,
      terminalErrorCode: 'PAY.INSUFFICIENT_BALANCE',
    });
    const bumped = bumpRedisCreateGenerationCounters(advanced.createGenerations, {
      attemptDelta: 1,
      successDelta: 1,
    });
    assert.equal(bumped.length, 2);
    assert.equal(bumped[0]!.attemptCount, 7);
    assert.equal(bumped[1]!.attemptCount, 1);
    assert.equal(bumped[1]!.successCount, 1);
  });
});
