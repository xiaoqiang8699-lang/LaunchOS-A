import Redis from 'ioredis';
import {
  buildRedisUrl,
  classifyRedisError,
  redisErrorUserMessage,
  redisTlsEnabled,
  type RedisErrorCode,
  type RedisTlsModeInput,
} from '@launchos/shared';
import type { DatabaseTestLocation } from '@launchos/shared';

export type RedisTestInput = {
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  databaseIndex?: number;
  tlsMode?: RedisTlsModeInput;
  timeoutMs?: number;
};

export type RedisTestResult = {
  success: boolean;
  latencyMs: number;
  location: DatabaseTestLocation;
  errorCode?: RedisErrorCode;
  message: string;
  technicalMessage?: string;
};

const DEFAULT_TIMEOUT_MS = 7_000;

export async function testRedisControlPlane(input: RedisTestInput): Promise<RedisTestResult> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = buildRedisUrl({
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
    databaseIndex: input.databaseIndex ?? 0,
    tlsMode: input.tlsMode ?? 'AUTO',
  });
  const tls = redisTlsEnabled(input.tlsMode);
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    ...(tls === undefined ? {} : { tls: tls ? {} : undefined }),
  });

  // ioredis often emits the real cause (WRONGPASS / ECONNRESET) on "error",
  // then rejects with a generic "Connection is closed." Keep the most specific event.
  let lastClientError: unknown;
  const onClientError = (err: unknown) => {
    if (!lastClientError) {
      lastClientError = err;
      return;
    }
    const prev = classifyRedisError(lastClientError).code;
    const next = classifyRedisError(err).code;
    if (prev === 'UNKNOWN' && next !== 'UNKNOWN') {
      lastClientError = err;
    }
  };
  client.on('error', onClientError);

  try {
    await withTimeout(client.connect(), timeoutMs);
    const pong = await withTimeout(client.ping(), timeoutMs);
    if (String(pong).toUpperCase() !== 'PONG') {
      return {
        success: false,
        latencyMs: Date.now() - started,
        location: 'CONTROL_PLANE',
        errorCode: 'UNKNOWN',
        message: redisErrorUserMessage('UNKNOWN'),
        technicalMessage: 'Unexpected PING response',
      };
    }
    return {
      success: true,
      latencyMs: Date.now() - started,
      location: 'CONTROL_PLANE',
      message: 'Redis 连接成功',
    };
  } catch (error) {
    const preferred = lastClientError ?? error;
    const classified = classifyRedisError(preferred);
    const code =
      (error as { __launchosCode?: RedisErrorCode }).__launchosCode ??
      (lastClientError as { __launchosCode?: RedisErrorCode } | undefined)?.__launchosCode ??
      classified.code;
    return {
      success: false,
      latencyMs: Date.now() - started,
      location: 'CONTROL_PLANE',
      errorCode: code,
      message: redisErrorUserMessage(code),
      technicalMessage: classified.technicalMessage,
    };
  } finally {
    client.off('error', onClientError);
    try {
      client.disconnect();
    } catch {
      // ignore
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('Connection timed out') as Error & {
            __launchosCode?: RedisErrorCode;
          };
          err.__launchosCode = 'TIMEOUT';
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
