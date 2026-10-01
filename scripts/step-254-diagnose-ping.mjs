/**
 * Diagnose resume PING failure. No Create. Does not print secrets.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const CR = 'cmu4xn1j60001riaw6gjh0rfn';
const INSTANCE = 'r-bp1e95c9abe63464';
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudRedisProvider } = require(resolve(root, 'packages/providers/dist/index.js'));
const { RemoteRunner } = require(resolve(root, 'packages/remote-runner/dist/index.js'));

const prisma = new PrismaClient();
try {
  const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
  const m = cr.metadata || {};
  const server = await prisma.serverInstance.findUnique({
    where: { id: m.serverInstanceId || 'cmu22cqo80007ri6wkt4krfsq' },
  });
  const account = await prisma.providerAccount.findFirst({
    where: { status: 'ACTIVE', provider: { type: 'ALIYUN' }, workspaceId: cr.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const provider = new AlibabaCloudRedisProvider({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region: cr.region || 'cn-hangzhou',
  });

  const placement = await provider.resolveNetworkPlacement({
    region: cr.region || 'cn-hangzhou',
    ecsInstanceId: server?.providerInstanceId || undefined,
    serverPublicIp: server?.host || undefined,
  });

  let connPriv = null;
  let connPub = null;
  try {
    const c = await provider.getConnectionInfo(INSTANCE, true);
    connPriv = { host: c.host, port: c.port };
  } catch (e) {
    connPriv = { error: String(e.message || e).slice(0, 240) };
  }
  try {
    const c = await provider.getConnectionInfo(INSTANCE, false);
    connPub = { host: c.host, port: c.port };
  } catch (e) {
    connPub = { error: String(e.message || e).slice(0, 240) };
  }

  // Ensure whitelist includes target public IP only (no 0.0.0.0/0)
  const wl = [...new Set([...(placement.whitelist || []), server?.host].filter(Boolean))];
  if (wl.includes('0.0.0.0/0')) throw new Error('refusing 0.0.0.0/0');
  await provider.setWhitelist({ instanceId: INSTANCE, securityIpList: wl.join(',') });

  const password = decryptCredential(m.passwordEncrypted);
  const host = connPub.host || m.connectionHost;
  const port = connPub.port || m.connectionPort || 6379;

  const runner = new RemoteRunner();
  const stamp = `${Date.now()}`;
  const envPath = `/tmp/launchos-redis-diag-${stamp}.env`;
  let ping = null;
  try {
    await runner.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password: decryptCredential(server.credentialEncrypted),
    });
    const envBody = [
      `REDISCLI_HOST=${host}`,
      `REDISCLI_PORT=${port}`,
      `REDISCLI_AUTH=${password.replace(/[\r\n]/g, '')}`,
    ].join('\n');
    await runner.writeTextFile(envPath, envBody, 0o600);
    // Try with explicit -a as well via env REDISCLI_AUTH (redis-cli native)
    const withAuthEnv = await runner.execute(
      [
        'docker run --rm --network host',
        `--env-file ${envPath}`,
        'redis:7-alpine',
        'sh -c',
        "\"redis-cli -h \\\"$REDISCLI_HOST\\\" -p \\\"$REDISCLI_PORT\\\" --no-auth-warning PING; echo EXIT:$?\"",
      ].join(' '),
      { timeoutMs: 60_000 },
    );
    const withAuthArg = await runner.execute(
      [
        'docker run --rm --network host',
        `--env-file ${envPath}`,
        'redis:7-alpine',
        'sh -c',
        "\"redis-cli -h \\\"$REDISCLI_HOST\\\" -p \\\"$REDISCLI_PORT\\\" -a \\\"$REDISCLI_AUTH\\\" --no-auth-warning PING; echo EXIT:$?\"",
      ].join(' '),
      { timeoutMs: 60_000 },
    );
    ping = {
      host,
      port,
      whitelist: wl,
      authEnv: {
        exitCode: withAuthEnv.exitCode,
        stdout: String(withAuthEnv.stdout || '').slice(0, 300),
        stderr: String(withAuthEnv.stderr || '').slice(0, 300),
      },
      authArg: {
        exitCode: withAuthArg.exitCode,
        stdout: String(withAuthArg.stdout || '').slice(0, 300),
        stderr: String(withAuthArg.stderr || '').slice(0, 300),
      },
    };
  } finally {
    try {
      await runner.execute(`rm -f ${envPath}`, { timeoutMs: 10_000 });
    } catch {
      /* ignore */
    }
    try {
      await runner.disconnect();
    } catch {
      /* ignore */
    }
  }

  console.log(
    JSON.stringify(
      {
        server: {
          id: server?.id,
          host: server?.host,
          port: server?.port,
          hasProviderInstanceId: Boolean(server?.providerInstanceId),
          providerInstanceIdPrefix: server?.providerInstanceId
            ? String(server.providerInstanceId).slice(0, 8)
            : null,
        },
        placement,
        redisVpc: { vpcId: m.vpcId, vSwitchId: m.vSwitchId },
        connPriv,
        connPub,
        ping,
        passwordLen: password.length,
        passwordClasses: [
          /[A-Z]/.test(password),
          /[a-z]/.test(password),
          /[0-9]/.test(password),
          /[^A-Za-z0-9]/.test(password),
        ].filter(Boolean).length,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
