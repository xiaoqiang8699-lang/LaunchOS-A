import { randomBytes } from 'node:crypto';

/**
 * Explicit allowlist of runtime secrets LaunchOS may generate.
 * Do NOT treat every *_SECRET / *_KEY as generatable.
 */
export const GENERATABLE_RUNTIME_SECRETS = new Set([
  'AUTH_SECRET',
  'NEXTAUTH_SECRET',
  'SESSION_SECRET',
  'JWT_SECRET',
]);

/** Keys that must always be user-provided (never auto-generated). */
export const NEVER_GENERATE_RUNTIME_CONFIG_KEYS = new Set([
  'DATABASE_URL',
  'REDIS_URL',
  'API_KEY',
  'OPENAI_API_KEY',
  'AWS_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'ALIBABA_CLOUD_ACCESS_KEY',
  'ALIBABA_CLOUD_ACCESS_KEY_ID',
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  'ALIYUN_ACCESS_KEY_ID',
  'ALIYUN_ACCESS_KEY_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'SMTP_PASSWORD',
  'SMTP_USER',
  'OAUTH_CLIENT_SECRET',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_SECRET',
]);

export type RuntimeConfigValueType = 'USER_PROVIDED' | 'GENERATABLE_SECRET';

export function isGeneratableRuntimeSecret(key: string): boolean {
  const upper = String(key || '').trim().toUpperCase();
  if (!upper) return false;
  if (NEVER_GENERATE_RUNTIME_CONFIG_KEYS.has(upper)) return false;
  return GENERATABLE_RUNTIME_SECRETS.has(upper);
}

export function runtimeConfigValueType(key: string): RuntimeConfigValueType {
  return isGeneratableRuntimeSecret(key) ? 'GENERATABLE_SECRET' : 'USER_PROVIDED';
}

/**
 * Cryptographically secure random secret for AUTH_SECRET / JWT_SECRET / etc.
 * Uses >= 32 bytes entropy, base64url (no padding).
 */
export function generateSecureRuntimeSecret(byteLength = 32): string {
  const size = Math.max(32, Math.floor(byteLength));
  return randomBytes(size).toString('base64url');
}

export function valueOriginLabel(source: string | null | undefined): string | null {
  const value = String(source || '').toUpperCase();
  if (value === 'GENERATED' || value === 'LAUNCHOS_GENERATED') return 'LaunchOS 自动生成';
  if (value === 'MANUAL') return '手动填写';
  return null;
}
