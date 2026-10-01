import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateSecureRuntimeSecret,
  isGeneratableRuntimeSecret,
  NEVER_GENERATE_RUNTIME_CONFIG_KEYS,
  runtimeConfigValueType,
  valueOriginLabel,
} from './runtime-secret-generation.js';

test('AUTH_SECRET is generatable; DATABASE_URL is not', () => {
  assert.equal(isGeneratableRuntimeSecret('AUTH_SECRET'), true);
  assert.equal(isGeneratableRuntimeSecret('JWT_SECRET'), true);
  assert.equal(isGeneratableRuntimeSecret('SESSION_SECRET'), true);
  assert.equal(isGeneratableRuntimeSecret('NEXTAUTH_SECRET'), true);
  assert.equal(isGeneratableRuntimeSecret('DATABASE_URL'), false);
  assert.equal(isGeneratableRuntimeSecret('OPENAI_API_KEY'), false);
  assert.equal(isGeneratableRuntimeSecret('CUSTOM_SECRET'), false);
  assert.equal(runtimeConfigValueType('AUTH_SECRET'), 'GENERATABLE_SECRET');
  assert.equal(runtimeConfigValueType('DATABASE_URL'), 'USER_PROVIDED');
  assert.ok(NEVER_GENERATE_RUNTIME_CONFIG_KEYS.has('AWS_SECRET_ACCESS_KEY'));
});

test('generateSecureRuntimeSecret has enough entropy and is unique', () => {
  const a = generateSecureRuntimeSecret(32);
  const b = generateSecureRuntimeSecret(32);
  assert.notEqual(a, b);
  assert.ok(a.length >= 43); // 32 bytes base64url ≈ 43 chars
  assert.doesNotMatch(a, /[+/=]/);
});

test('valueOriginLabel maps sources', () => {
  assert.equal(valueOriginLabel('GENERATED'), 'LaunchOS 自动生成');
  assert.equal(valueOriginLabel('MANUAL'), '手动填写');
  assert.equal(valueOriginLabel(null), null);
});
