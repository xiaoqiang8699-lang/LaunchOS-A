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

const script = `#!/bin/bash
set +e
echo ===WORKER===
podman ps -a --filter name=launchos-alpha-worker --format '{{.Names}} {{.Status}} {{.Image}}'
echo ===HB===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"lastSeenAt\\"::text, left(coalesce(meta::text,''),300) FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 5;"
echo ===LOGS===
podman logs --tail 80 launchos-alpha-worker 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,})[=:][^ ]+/\\1=***/gi' | tail -80
echo ===QUEUED===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"createdAt\\"::text FROM \\"Deployment\\" WHERE status='QUEUED' ORDER BY \\"createdAt\\" DESC LIMIT 5;"
echo ===REDIS===
podman exec launchos-alpha-redis redis-cli LLEN bull:deploymentQueue:wait 2>/dev/null; podman exec launchos-alpha-redis redis-cli LLEN bull:deploymentQueue:active 2>/dev/null; podman exec launchos-alpha-redis redis-cli KEYS 'bull:deploymentQueue:*' 2>/dev/null | head
echo ===PATCH===
podman exec launchos-alpha-worker grep -n NPM_CONFIG_PRODUCTION /app/packages/deployment/dist/engine/deployment-engine.service.js | head
`;
await runner.writeTextFile('/opt/launchos/bin/step317-worker-qdiag.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-worker-qdiag.sh && /opt/launchos/bin/step317-worker-qdiag.sh'),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
