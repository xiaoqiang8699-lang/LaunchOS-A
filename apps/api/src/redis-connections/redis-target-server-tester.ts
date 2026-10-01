import { RemoteRunner } from '@launchos/remote-runner';
import {
  classifyRedisError,
  redisErrorUserMessage,
  redactDatabaseSecrets,
  type RedisErrorCode,
} from '@launchos/shared';
import type { RedisTestInput, RedisTestResult } from './redis-control-plane-tester';

export type TargetServerCredentials = {
  host: string;
  port: number;
  username: string;
  password: string;
};

/**
 * Test Redis connectivity from the target deployment server via redis-cli container.
 * Credentials travel only through a temporary env-file (chmod 600).
 */
export async function testRedisTargetServer(
  input: RedisTestInput,
  server: TargetServerCredentials,
): Promise<RedisTestResult> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? 12_000;
  const runner = new RemoteRunner();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const envPath = `/tmp/launchos-redis-test-${stamp}.env`;
  const secrets = [input.password, input.username].filter(Boolean) as string[];

  try {
    await runner.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    });

    const tls = input.tlsMode === 'REQUIRE';
    const db = Number.isFinite(input.databaseIndex)
      ? Math.max(0, Math.floor(Number(input.databaseIndex)))
      : 0;
    const envBody = [
      `REDISCLI_HOST=${escapeEnv(input.host)}`,
      `REDISCLI_PORT=${Number(input.port) || 6379}`,
      `REDIS_DB=${db}`,
      input.username?.trim() ? `REDISCLI_USER=${escapeEnv(input.username.trim())}` : '',
      input.password ? `REDISCLI_AUTH=${escapeEnv(input.password)}` : '',
      tls ? 'REDIS_TLS=1' : 'REDIS_TLS=0',
    ]
      .filter(Boolean)
      .join('\n');

    await runner.writeTextFile(envPath, envBody, 0o600);

    // redis-cli reads REDISCLI_AUTH / REDISCLI_USER from env — never shell args.
    const command = [
      'docker run --rm --network host',
      `--env-file ${envPath}`,
      'redis:7-alpine',
      'sh -c',
      "'ARGS=\"-h $REDISCLI_HOST -p $REDISCLI_PORT -n $REDIS_DB\"; " +
        '[ "$REDIS_TLS" = "1" ] && ARGS="$ARGS --tls --insecure"; ' +
        'redis-cli $ARGS PING\'',
    ].join(' ');

    const result = await runner.execute(command, { timeoutMs });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const safe = redactDatabaseSecrets(output, secrets);
    if (result.exitCode === 0 && /PONG/i.test(output)) {
      return {
        success: true,
        latencyMs: Date.now() - started,
        location: 'TARGET_SERVER',
        message: 'Redis 连接成功（目标服务器）',
      };
    }

    const classified = classifyFromRemoteOutput(safe);
    return {
      success: false,
      latencyMs: Date.now() - started,
      location: 'TARGET_SERVER',
      errorCode: classified,
      message: redisErrorUserMessage(classified),
      technicalMessage: 'Target server Redis test failed',
    };
  } catch (error) {
    const classified = classifyRedisError(error);
    return {
      success: false,
      latencyMs: Date.now() - started,
      location: 'TARGET_SERVER',
      errorCode: classified.code,
      message: redisErrorUserMessage(classified.code),
      technicalMessage: classified.technicalMessage,
    };
  } finally {
    try {
      await runner.execute(`rm -f ${envPath}`, { timeoutMs: 5_000 });
    } catch {
      // ignore
    }
    try {
      await runner.disconnect();
    } catch {
      // ignore
    }
  }
}

function escapeEnv(value: string): string {
  return value.replace(/\n/g, '').replace(/\r/g, '');
}

function classifyFromRemoteOutput(output: string): RedisErrorCode {
  const lower = output.toLowerCase();
  if (lower.includes('wrongpass') || lower.includes('noauth') || lower.includes('invalid password')) {
    return 'AUTH_FAILED';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'TIMEOUT';
  }
  if (lower.includes('name or service not known') || lower.includes('nodename nor servname')) {
    return 'DNS_ERROR';
  }
  if (lower.includes('connection refused') || lower.includes('no route to host')) {
    return 'HOST_UNREACHABLE';
  }
  if (lower.includes('ssl') || lower.includes('tls')) {
    return 'TLS_ERROR';
  }
  if (lower.includes('db index is out of range')) {
    return 'INVALID_DATABASE';
  }
  return 'UNKNOWN';
}
