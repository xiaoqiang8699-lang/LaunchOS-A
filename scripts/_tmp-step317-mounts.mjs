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
  readyTimeoutMs: 20000,
});

const r = await runner.execute(
  shellCommand(
    `podman inspect launchos-alpha-api --format '{{range .Mounts}}{{.Source}}->{{.Destination}}{{println}}{{end}}'; echo ---; podman inspect launchos-alpha-worker --format '{{range .Mounts}}{{.Source}}->{{.Destination}}{{println}}{{end}}'; echo ---; podman exec launchos-alpha-api sh -c 'ls -la /tmp/launchos-repos 2>/dev/null | head'; echo ---; podman exec launchos-alpha-worker sh -c 'command -v git || echo NO_GIT; ls /usr/bin/git 2>/dev/null || true; cat /etc/os-release | head -3'`,
  ),
  { timeoutMs: 30000 },
);
console.log(r.stdout || r.stderr);

await runner.disconnect();
await prisma.$disconnect();
