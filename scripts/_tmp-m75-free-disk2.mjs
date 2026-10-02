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
const TARGET_HOST = '116.62.198.184';
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function run(cmd, timeoutMs = 300000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  console.log('>', cmd.slice(0, 160));
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-2500));
  return r;
}

// Keep only m75; delete older launchos-alpha tags aggressively
await run('rm -rf /opt/launchos/tmp/step34-buildctx /opt/launchos/tmp/*.tar 2>/dev/null; true');
await run(
  "podman images --format '{{.ID}} {{.Repository}}:{{.Tag}}' | awk '!/m75/ && /launchos-alpha/ {print $1}' | sort -u | xargs -r podman rmi -f",
);
await run('podman image prune -af');
await run('podman system prune -af --volumes=false');
await run('journalctl --vacuum-size=50M 2>/dev/null || true');
await run('df -h / | head -5');
await run('podman images --format "{{.Repository}}:{{.Tag}} {{.Size}}" | head -30');

await run('podman restart launchos-alpha-postgres');
let ready = false;
for (let i = 0; i < 60; i++) {
  const r = await runner.execute(
    shellCommand('podman exec launchos-alpha-postgres pg_isready -U launchos_alpha -d launchos'),
    { timeoutMs: 20000 },
  );
  console.log('pg', i, r.exitCode, (r.stdout || r.stderr || '').trim().slice(0, 120));
  if (r.exitCode === 0) {
    ready = true;
    break;
  }
  await new Promise((x) => setTimeout(x, 3000));
}
if (!ready) {
  await run('podman logs --tail 30 launchos-alpha-postgres');
  throw new Error('postgres not ready');
}

await run('podman restart launchos-alpha-api');
for (let i = 0; i < 40; i++) {
  const r = await runner.execute(shellCommand('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health'), {
    timeoutMs: 10000,
  });
  if (r.exitCode === 0) {
    console.log('API_HEALTH_OK');
    break;
  }
  await new Promise((x) => setTimeout(x, 3000));
}

await runner.disconnect();
await prisma.$disconnect();
console.log('DISK_OK');
