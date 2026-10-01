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
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

async function run(label, cmd, timeoutMs = 120000) {
  console.log('>>', label);
  try {
    const r = await runner.execute(shellCommand(cmd), { timeoutMs });
    console.log(String(r.stdout || '').slice(0, 2500));
    if (r.stderr) console.log('stderr', String(r.stderr).slice(0, 800));
    console.log('exit', r.exitCode);
  } catch (error) {
    console.log('FAIL', error instanceof Error ? error.message : String(error));
  }
}

await run('images', 'podman images --format "{{.Repository}}:{{.Tag}} {{.ID}}" | head -n 30');
await run('alpha-ps', 'podman ps -a --format "{{.Names}} {{.Status}} {{.Ports}}" | grep -Ei "alpha|postgres|redis" || true');
await run('data', 'ls -la /opt/launchos/data/postgres /opt/launchos/data/redis; du -sh /opt/launchos/data/postgres /opt/launchos/data/redis');
await run('which-podman', 'which podman; podman info --format "{{.Host.RemoteSocket.Path}}" 2>/dev/null || true');
await run('pull-pg', 'timeout 240 podman pull docker.io/library/postgres:16-alpine; echo PULL_EXIT:$?', 300000);
await run('images2', 'podman images | grep postgres || true');

await runner.disconnect();
await prisma.$disconnect();
