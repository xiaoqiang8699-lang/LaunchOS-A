/**
 * Probe postgres volume permissions on Alpha host.
 */
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
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (process.env[k] === undefined) process.env[k] = v;
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const r = await runner.execute(
  shellCommand(
    [
      'echo HOST_DATA; ls -lan /opt/launchos/data/postgres | head -n 25',
      'echo ----',
      'echo CONTAINER_ID; podman exec launchos-alpha-postgres id || true',
      'echo ----',
      'echo CONTAINER_DATA; podman exec launchos-alpha-postgres ls -lan /var/lib/postgresql/data | head -n 25 || true',
      'echo ----',
      'echo LOGS; podman logs --tail 50 launchos-alpha-postgres 2>&1 || true',
      'echo ----',
      'echo REDIS_DATA; ls -lan /opt/launchos/data/redis | head -n 20',
      'echo ----',
      'echo REDIS_PING; podman exec launchos-alpha-redis redis-cli ping || true',
    ].join('; '),
  ),
  { timeoutMs: 60000 },
);
console.log('exit', r.exitCode);
console.log(r.stdout);
if (r.stderr) console.log('STDERR', r.stderr);
await runner.disconnect();
await prisma.$disconnect();
