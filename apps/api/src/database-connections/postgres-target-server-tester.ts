import { RemoteRunner } from '@launchos/remote-runner';
import {
  classifyDatabaseError,
  databaseErrorUserMessage,
  redactDatabaseSecrets,
  type DatabaseErrorCode,
} from '@launchos/shared';
import type { PostgresTestInput, PostgresTestResult } from './postgres-control-plane-tester';

export type TargetServerCredentials = {
  host: string;
  port: number;
  username: string;
  password: string;
};

/**
 * Test PostgreSQL connectivity from the target deployment server.
 * Password is transferred via temporary env-file (chmod 600) and never placed in shell args.
 */
export async function testPostgresTargetServer(
  input: PostgresTestInput,
  server: TargetServerCredentials,
): Promise<PostgresTestResult> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? 12_000;
  const runner = new RemoteRunner();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const envPath = `/tmp/launchos-pg-test-${stamp}.env`;
  const secrets = [input.password, input.username];

  try {
    await runner.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
    });

    const sslMode =
      input.sslMode === 'REQUIRE' ? 'require' : input.sslMode === 'DISABLE' ? 'disable' : 'prefer';
    const envBody = [
      `PGHOST=${escapeEnv(input.host)}`,
      `PGPORT=${Number(input.port) || 5432}`,
      `PGUSER=${escapeEnv(input.username)}`,
      `PGPASSWORD=${escapeEnv(input.password)}`,
      `PGDATABASE=${escapeEnv(input.databaseName)}`,
      `PGSSLMODE=${sslMode}`,
      `PGCONNECT_TIMEOUT=${Math.max(1, Math.floor(timeoutMs / 1000))}`,
    ].join('\n');

    await runner.writeTextFile(envPath, envBody, 0o600);

    const command = [
      'docker run --rm --network host',
      `--env-file ${envPath}`,
      'postgres:16-alpine',
      'psql -v ON_ERROR_STOP=1 -c "SELECT 1"',
    ].join(' ');

    const result = await runner.execute(command, { timeoutMs });
    if (result.exitCode === 0) {
      return {
        success: true,
        latencyMs: Date.now() - started,
        location: 'TARGET_SERVER',
        message: '数据库连接成功（目标服务器）',
      };
    }

    const stderrSafe = redactDatabaseSecrets(result.stderr || result.stdout || '', secrets);
    const classified = classifyFromRemoteOutput(stderrSafe);
    return {
      success: false,
      latencyMs: Date.now() - started,
      location: 'TARGET_SERVER',
      errorCode: classified,
      message: databaseErrorUserMessage(classified),
      technicalMessage: 'Target server database test failed',
    };
  } catch (error) {
    const classified = classifyDatabaseError(error);
    return {
      success: false,
      latencyMs: Date.now() - started,
      location: 'TARGET_SERVER',
      errorCode: classified.code,
      message: databaseErrorUserMessage(classified.code),
      technicalMessage: classified.technicalMessage,
    };
  } finally {
    try {
      await runner.execute(`rm -f ${envPath}`, { timeoutMs: 5_000 });
    } catch {
      // ignore cleanup failures
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

function classifyFromRemoteOutput(output: string): DatabaseErrorCode {
  const lower = output.toLowerCase();
  if (lower.includes('password authentication failed') || lower.includes('fe_sendauth')) {
    return 'AUTH_FAILED';
  }
  if (lower.includes('does not exist') && lower.includes('database')) {
    return 'DATABASE_NOT_FOUND';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'TIMEOUT';
  }
  if (lower.includes('could not translate host') || lower.includes('name or service not known')) {
    return 'DNS_ERROR';
  }
  if (lower.includes('connection refused') || lower.includes('no route to host')) {
    return 'HOST_UNREACHABLE';
  }
  if (lower.includes('ssl')) {
    return 'SSL_ERROR';
  }
  return 'UNKNOWN';
}
