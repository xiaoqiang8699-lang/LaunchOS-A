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
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { AlibabaCloudDnsProvider } = requireDomain('@launchos/domain');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const prisma = new PrismaClient();
const out = {
  databaseHost: null,
  redisHost: null,
  dns: {},
  managed: null,
  containers: null,
  sshExit: null,
  error: null,
};

try {
  const db = new URL(process.env.DATABASE_URL || 'postgresql://x@localhost/x');
  out.databaseHost = `${db.hostname}:${db.port || '5432'}/${db.pathname.replace(/^\//, '')}`;
  const redis = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  out.redisHost = `${redis.hostname}:${redis.port || '6379'}`;

  const account = await prisma.providerAccount.findFirst({
    where: { provider: { type: 'ALIYUN_DNS' }, credentialEncrypted: { not: null } },
    include: { provider: true },
  });

  if (account?.credentialEncrypted) {
    const raw = JSON.parse(decryptCredential(account.credentialEncrypted));
    const dns = new AlibabaCloudDnsProvider(
      { accessKey: raw.accessKey, secretKey: raw.secretKey },
      'zsaos.com',
    );
    for (const rr of [
      'alpha',
      'api-alpha',
      'web-launchos',
      'api-launchos',
      'oneclick-web',
      'launchos-real-test',
    ]) {
      try {
        const rows = await dns.findARecordsReadOnly(rr);
        out.dns[rr] = rows.map((r) => ({ value: r.value, recordId: r.recordId }));
      } catch (error) {
        out.dns[rr] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
  } else {
    out.dns = { error: 'no ALIYUN_DNS credential account' };
  }

  const server = await prisma.serverInstance.findFirst({
    where: { host: '116.62.198.184' },
  });
  if (!server) {
    out.managed = { error: 'managed node not found' };
  } else {
    out.managed = {
      id: server.id,
      host: server.host,
      scope: server.scope,
      status: server.status,
      name: server.name,
    };
    const password = decryptCredential(server.credentialEncrypted);
    const username = resolveServerSshUsername(server.username);
    const runner = new RemoteRunner();
    await runner.connect({
      host: server.host,
      port: server.port,
      username,
      password,
    });
    try {
      const probe = await runner.execute(
        shellCommand(
          [
            'echo CONTAINERS_BEGIN',
            'podman ps --format "{{.Names}} {{.Ports}} {{.Image}}" 2>/dev/null | head -n 40 || true',
            'echo CONTAINERS_END',
            'echo LISTEN_BEGIN',
            'ss -lntp 2>/dev/null | grep -E ":5432|:6379|:3900" || true',
            'echo LISTEN_END',
          ].join('; '),
        ),
        { timeoutMs: 60_000 },
      );
      out.containers = String(probe.stdout || '').slice(0, 4000);
      out.sshExit = probe.exitCode;
    } finally {
      await runner.disconnect();
    }
  }
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
} finally {
  await prisma.$disconnect();
}

console.log(JSON.stringify(out, null, 2));
