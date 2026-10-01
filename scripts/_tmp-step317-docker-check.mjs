import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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

await runner.writeTextFile(
  '/opt/launchos/bin/step317-docker-check.sh',
  `#!/bin/bash
echo ===HOST===
which docker podman || true
docker --version 2>&1 | head -1 || true
podman --version 2>&1 | head -1 || true
echo ===IMAGES===
podman images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' | head -40
echo ===NODE===
podman image exists node:20-alpine && echo HAS_NODE_ALPINE || echo NO_NODE_ALPINE
podman image exists docker.io/library/node:20-alpine && echo HAS_FQ || echo NO_FQ
echo ===SOCK===
ls -la /var/run/docker.sock /run/podman/podman.sock /var/run/podman/podman.sock 2>&1 | head -10
echo ===WORKER===
podman exec launchos-alpha-worker sh -c 'which docker; which podman; ls -la /var/run/docker.sock /run/podman/podman.sock 2>&1 | head -5' || true
echo ===DISK===
df -h /opt /var | head -10
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-docker-check.sh && /opt/launchos/bin/step317-docker-check.sh'),
  { timeoutMs: 60000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-docker-check.txt'), r.stdout || r.stderr || '');
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
