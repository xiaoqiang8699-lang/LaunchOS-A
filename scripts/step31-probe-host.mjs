/**
 * Probe managed host for node/podman/nginx layout (Step 31 prep).
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
      'echo NODE=$(command -v node || true); node -v 2>/dev/null || true',
      'echo PODMAN=$(command -v podman); podman --version',
      'echo NGINX=$(command -v nginx); ls -la /opt/launchos/gateway/active 2>/dev/null | head',
      'echo CERT; ls -la /www/server/panel/vhost/cert/launchos-wildcard-zsaos/ 2>/dev/null | head',
      'echo DISK; df -h / | tail -1',
      'echo MEM; free -m | head -2',
      'echo SOCK; ls -la /run/podman/podman.sock /var/run/docker.sock 2>/dev/null || true',
      'echo ROUTES_HEAD; head -n 40 /opt/launchos/gateway/active/launchos-routes.conf 2>/dev/null || true',
    ].join('; echo ----; '),
  ),
  { timeoutMs: 60000 },
);
console.log(r.stdout);
console.log('exit', r.exitCode);
await runner.disconnect();
await prisma.$disconnect();
