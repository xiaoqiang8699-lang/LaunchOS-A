import { getRedisConnection } from './queue';

type RedisLike = {
  set(key: string, value: string, mode: string, ttl: number, nx: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  quit(): Promise<void>;
};

let RedisCtor: (new (opts: object) => RedisLike) | null = null;

function loadRedis(): new (opts: object) => RedisLike {
  if (RedisCtor) {
    return RedisCtor;
  }
  // ioredis is available transitively via bullmq in apps; optional peer for packages.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('ioredis') as { default?: new (opts: object) => RedisLike } & (
    | (new (opts: object) => RedisLike)
    | { Redis: new (opts: object) => RedisLike }
  );
  RedisCtor =
    (mod as { default?: new (opts: object) => RedisLike }).default ??
    (mod as { Redis?: new (opts: object) => RedisLike }).Redis ??
    (mod as new (opts: object) => RedisLike);
  return RedisCtor;
}

/**
 * Short-lived Redis lock (SET NX EX). Used for server port allocation.
 * Keeps deps light: uses ioredis if present (bullmq installs it).
 */
export async function withRedisLock<T>(
  lockKey: string,
  ttlMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const acquired = await acquireRedisLockWithWait(lockKey, ttlMs);
  try {
    return await work();
  } finally {
    await acquired.release();
  }
}

export type RedisLockHandle = {
  release: () => Promise<void>;
};

/**
 * Try lock once (no wait). Returns null if busy.
 * Used by server initialization to return alreadyInProgress without blocking.
 */
export async function tryAcquireRedisLock(
  lockKey: string,
  ttlMs: number,
): Promise<RedisLockHandle | null> {
  const Redis = loadRedis();
  const conn = getRedisConnection();
  const redis = new Redis({
    host: conn.host,
    port: conn.port,
    username: conn.username,
    password: conn.password,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const key = `launchos:lock:${lockKey}`;
  const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
  try {
    await (redis as unknown as { connect?: () => Promise<void> }).connect?.();
    const ok = await redis.set(key, token, 'EX', ttlSec, 'NX');
    if (ok !== 'OK') {
      await redis.quit().catch(() => undefined);
      return null;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          await redis.eval(
            `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
            1,
            key,
            token,
          );
        } catch {
          /* ignore */
        } finally {
          await redis.quit().catch(() => undefined);
        }
      },
    };
  } catch (error) {
    await redis.quit().catch(() => undefined);
    throw error;
  }
}

/** Wait-and-acquire (legacy behavior for withRedisLock). */
export async function acquireRedisLockWithWait(
  lockKey: string,
  ttlMs: number,
  waitMs?: number,
): Promise<RedisLockHandle> {
  const deadline = Date.now() + Math.max(waitMs ?? ttlMs, 15_000);
  while (Date.now() < deadline) {
    const handle = await tryAcquireRedisLock(lockKey, ttlMs);
    if (handle) return handle;
    await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 50)));
  }
  throw new Error('资源锁等待超时，请稍后重试');
}
