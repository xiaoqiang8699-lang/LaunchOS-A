import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
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
  shellCommand(`echo '===INSPECT==='; podman inspect launchos-alpha-web --format 'Status={{.State.Status}} Exit={{.State.ExitCode}} Error={{.State.Error}} Health={{.State.Health.Status}} Started={{.State.StartedAt}}'; echo '===LOGS==='; podman logs --tail 80 launchos-alpha-web 2>&1; echo '===WHO_39002==='; podman ps --format '{{.Names}} {{.Ports}}' | grep 39002; echo '===NC==='; (echo >/dev/tcp/127.0.0.1/39082) >/dev/null 2>&1 && echo tcp39082=open || echo tcp39082=closed; (echo >/dev/tcp/127.0.0.1/39002) >/dev/null 2>&1 && echo tcp39002=open || echo tcp39002=closed; curl -v --max-time 5 http://127.0.0.1:39082/ 2>&1 | tail -30`),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
