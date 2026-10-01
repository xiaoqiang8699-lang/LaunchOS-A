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

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^\s]+/gi, '$1=***');
}

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

await runner.writeTextFile(
  '/opt/launchos/bin/step317-patch-worker-git.sh',
  `#!/bin/bash
set -euo pipefail
echo ===BEFORE===
podman exec launchos-alpha-worker sh -c 'which git; git --version; grep -c "http.version=HTTP/1.1" /app/packages/git/dist/git.service.js || true; ls /app/packages/git/dist/git.service.js'
# Copy fixed git package + github package from API image (same monorepo build as step317 API)
podman cp launchos-alpha-api:/app/packages/git/dist/. /tmp/git-dist-317/
podman cp launchos-alpha-api:/app/packages/github/dist/. /tmp/github-dist-317/ 2>/dev/null || true
podman cp /tmp/git-dist-317/. launchos-alpha-worker:/app/packages/git/dist/
if [ -d /tmp/github-dist-317 ]; then podman cp /tmp/github-dist-317/. launchos-alpha-worker:/app/packages/github/dist/; fi
echo ===AFTER===
podman exec launchos-alpha-worker sh -c 'grep -c "http.version=HTTP/1.1" /app/packages/git/dist/git.service.js; grep -c resolveAuthForSource /app/apps/worker/dist -r 2>/dev/null | head; ls /app/packages/git/dist/git.service.js'
podman restart launchos-alpha-worker
sleep 6
podman logs --tail 25 launchos-alpha-worker
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"workerId\\", status, \\"lastSeenAt\\"::text FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 3;"
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-patch-worker-git.sh && /opt/launchos/bin/step317-patch-worker-git.sh'),
  { timeoutMs: 120000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-patch-worker.txt'), redact(r.stdout || r.stderr));
console.log(redact(r.stdout || r.stderr));

await runner.disconnect();
await prisma.$disconnect();
