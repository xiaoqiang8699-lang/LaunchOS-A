export type DatabaseSslModeInput = 'AUTO' | 'REQUIRE' | 'DISABLE';

export type BuildDatabaseUrlInput = {
  host: string;
  port: number;
  databaseName: string;
  username: string;
  password: string;
  sslMode?: DatabaseSslModeInput;
};

/**
 * Build a postgresql:// URL with correct percent-encoding for special characters.
 * Never log the result — it contains credentials.
 */
export function buildPostgresDatabaseUrl(input: BuildDatabaseUrlInput): string {
  const host = input.host.trim();
  const databaseName = input.databaseName.trim();
  const username = encodeURIComponent(input.username);
  const password = encodeURIComponent(input.password);
  const port = Number(input.port) || 5432;
  if (!host || !databaseName || !input.username) {
    throw new Error('INVALID_DATABASE_FIELDS');
  }

  const params = new URLSearchParams();
  const sslMode = input.sslMode ?? 'AUTO';
  if (sslMode === 'REQUIRE') {
    params.set('sslmode', 'require');
  } else if (sslMode === 'DISABLE') {
    params.set('sslmode', 'disable');
  }
  // AUTO: omit sslmode and let the client negotiate.

  const query = params.toString();
  const base = `postgresql://${username}:${password}@${host}:${port}/${encodeURIComponent(databaseName)}`;
  return query ? `${base}?${query}` : base;
}

export function sslModeToPgOption(sslMode: DatabaseSslModeInput | undefined): boolean | undefined {
  if (sslMode === 'REQUIRE') {
    return true;
  }
  if (sslMode === 'DISABLE') {
    return false;
  }
  return undefined;
}
