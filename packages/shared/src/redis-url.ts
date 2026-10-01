export type RedisTlsModeInput = 'AUTO' | 'REQUIRE' | 'DISABLE';

export type BuildRedisUrlInput = {
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  databaseIndex?: number;
  tlsMode?: RedisTlsModeInput;
};

/**
 * Build redis:// or rediss:// URL with correct percent-encoding.
 * Never log the result — it may contain credentials.
 */
export function buildRedisUrl(input: BuildRedisUrlInput): string {
  const host = input.host.trim();
  if (!host) {
    throw new Error('INVALID_REDIS_FIELDS');
  }
  const port = Number(input.port) || 6379;
  const db = Number.isFinite(input.databaseIndex) ? Math.max(0, Math.floor(Number(input.databaseIndex))) : 0;
  const tlsMode = input.tlsMode ?? 'AUTO';
  const scheme = tlsMode === 'REQUIRE' ? 'rediss' : 'redis';

  const username = input.username?.trim() || '';
  const password = input.password ?? '';
  const hasPassword = password.length > 0;
  const hasUsername = username.length > 0;

  let auth = '';
  if (hasUsername && hasPassword) {
    auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
  } else if (hasPassword) {
    auth = `:${encodeURIComponent(password)}@`;
  } else if (hasUsername) {
    auth = `${encodeURIComponent(username)}@`;
  }

  return `${scheme}://${auth}${host}:${port}/${db}`;
}

export function redisTlsEnabled(tlsMode: RedisTlsModeInput | undefined): boolean | undefined {
  if (tlsMode === 'REQUIRE') return true;
  if (tlsMode === 'DISABLE') return false;
  return undefined;
}
