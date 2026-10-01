import { Client } from 'pg';
import {
  buildPostgresDatabaseUrl,
  classifyDatabaseError,
  databaseErrorUserMessage,
  sslModeToPgOption,
  type DatabaseErrorCode,
  type DatabaseSslModeInput,
  type DatabaseTestLocation,
} from '@launchos/shared';

export type PostgresTestInput = {
  host: string;
  port: number;
  databaseName: string;
  username: string;
  password: string;
  sslMode?: DatabaseSslModeInput;
  timeoutMs?: number;
};

export type PostgresTestResult = {
  success: boolean;
  latencyMs: number;
  location: DatabaseTestLocation;
  errorCode?: DatabaseErrorCode;
  message: string;
  technicalMessage?: string;
};

const DEFAULT_TIMEOUT_MS = 8_000;

export async function testPostgresControlPlane(
  input: PostgresTestInput,
): Promise<PostgresTestResult> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectionString = buildPostgresDatabaseUrl(input);
  const ssl = sslModeToPgOption(input.sslMode);
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    ...(ssl === undefined ? {} : { ssl: ssl ? { rejectUnauthorized: false } : false }),
  });

  try {
    await withTimeout(client.connect(), timeoutMs, 'TIMEOUT');
    await withTimeout(client.query('SELECT 1 AS ok'), timeoutMs, 'TIMEOUT');
    return {
      success: true,
      latencyMs: Date.now() - started,
      location: 'CONTROL_PLANE',
      message: '数据库连接成功',
    };
  } catch (error) {
    const classified = classifyDatabaseError(error);
    const code = (error as { __launchosCode?: DatabaseErrorCode }).__launchosCode ?? classified.code;
    return {
      success: false,
      latencyMs: Date.now() - started,
      location: 'CONTROL_PLANE',
      errorCode: code,
      message: databaseErrorUserMessage(code),
      technicalMessage: classified.technicalMessage,
    };
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, code: DatabaseErrorCode): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('Connection timed out') as Error & { __launchosCode?: DatabaseErrorCode };
          err.__launchosCode = code;
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
