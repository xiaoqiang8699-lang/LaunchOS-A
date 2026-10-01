import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const prisma = new PrismaClient();
const out = {};

try {
  const counts = {};
  for (const [key, fn] of Object.entries({
    users: () => prisma.user.count(),
    workspaces: () => prisma.workspace.count(),
    projects: () => prisma.project.count(),
    gitConnections: () => prisma.gitProviderConnection.count(),
    alphaSessions: () => prisma.alphaTestSession.count(),
    deployments: () => prisma.deployment.count(),
    subscriptions: () => prisma.subscription.count(),
    payments: () => prisma.payment.count().catch(() => null),
    authSessions: () => prisma.authSession.count(),
  })) {
    try {
      counts[key] = await fn();
    } catch (error) {
      counts[key] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  out.tableCounts = counts;

  const dbSize = await prisma.$queryRawUnsafe(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS size, current_database() AS name`,
  );
  out.postgresSize = dbSize;

  const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
  if (!server) throw new Error('managed node missing');
  const runner = new RemoteRunner();
  await runner.connect({
    host: server.host,
    port: server.port,
    username: resolveServerSshUsername(server.username),
    password: decryptCredential(server.credentialEncrypted),
  });
  try {
    const probe = await runner.execute(
      shellCommand(
        [
          'echo CAP_BEGIN',
          'nproc',
          'free -h',
          'df -hT / /var /opt 2>/dev/null || df -hT',
          'uptime',
          'echo CAP_END',
          'echo LOAD_BEGIN',
          'podman stats --no-stream --format "{{.Name}} cpu={{.CPU}} mem={{.MemUsage}}" 2>/dev/null | head -n 30 || true',
          'echo LOAD_END',
          'echo PORT_BEGIN',
          'ss -lntp | head -n 100',
          'echo PORT_END',
          'echo DISK_BEGIN',
          'du -sh /var/lib/containers 2>/dev/null || true',
          'du -sh /opt/launchos 2>/dev/null || true',
          'ls -la /opt/launchos 2>/dev/null | head -n 40 || true',
          'echo DISK_END',
          'echo SG_HINT_BEGIN',
          'curl -s --max-time 2 ifconfig.me || true',
          'echo',
          'echo SG_HINT_END',
        ].join('; '),
      ),
      { timeoutMs: 120000 },
    );
    out.managed = {
      exit: probe.exitCode,
      stdout: String(probe.stdout || '').slice(0, 12000),
      stderr: String(probe.stderr || '').slice(0, 1500),
    };
  } finally {
    await runner.disconnect();
  }

  // Redis keyspace summary (no values)
  try {
    const Redis = requireApi('ioredis');
    const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });
    await redis.connect();
    const info = await redis.info('keyspace');
    const dbsize = await redis.dbsize();
    const sample = [];
    let cursor = '0';
    do {
      const res = await redis.scan(cursor, 'COUNT', 100);
      cursor = res[0];
      for (const key of res[1]) {
        if (sample.length >= 40) break;
        const type = await redis.type(key);
        sample.push({ key, type });
      }
    } while (cursor !== '0' && sample.length < 40);
    out.redis = { dbsize, info: info.slice(0, 500), sampleKeys: sample };
    await redis.quit();
  } catch (error) {
    out.redis = { error: error instanceof Error ? error.message : String(error) };
  }
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
} finally {
  await prisma.$disconnect();
}

console.log(JSON.stringify(out, null, 2));
