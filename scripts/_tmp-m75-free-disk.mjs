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

async function run(cmd, timeoutMs = 180000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  console.log('>', cmd.slice(0, 120));
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-2000));
  console.log('exit', r.exitCode);
  return r;
}

await run('df -h / /opt /var 2>/dev/null | head -20');
await run('du -sh /opt/launchos/tmp/* 2>/dev/null | sort -hr | head -20');
await run('podman images --format "{{.Repository}}:{{.Tag}} {{.Size}} {{.ID}}" | head -40');

// Free space: remove old tars and dangling/old tags (keep m75)
await run('rm -f /opt/launchos/tmp/*.tar /opt/launchos/tmp/*.sql 2>/dev/null; ls -lah /opt/launchos/tmp | head -30');
await run(
  `podman images --format '{{.Repository}}:{{.Tag}}' | grep -E 'launchos-alpha-(api|web):(m7|m72|m73|m74|m6|ops|ux)' | grep -v ':m75$' | while read t; do podman rmi -f \"$t\" 2>/dev/null || true; done; podman image prune -f 2>/dev/null || true`,
  300000,
);
await run('df -h / /opt 2>/dev/null | head -10');

// Restart postgres after freeing disk
await run('podman restart launchos-alpha-postgres', 120000);
for (let i = 0; i < 40; i++) {
  const ready = await runner.execute(
    shellCommand('podman exec launchos-alpha-postgres pg_isready -U launchos_alpha -d launchos'),
    { timeoutMs: 20000 },
  );
  console.log('pg_isready', i, ready.exitCode, (ready.stdout || '').trim());
  if (ready.exitCode === 0) break;
  await new Promise((r) => setTimeout(r, 3000));
  if (i === 39) throw new Error('postgres still not ready after cleanup');
}

await run('podman restart launchos-alpha-api', 120000);
await new Promise((r) => setTimeout(r, 8000));
await run('curl -sf --max-time 5 http://127.0.0.1:39110/api/v1/health || true');

await runner.disconnect();
await prisma.$disconnect();
console.log('CLEANUP_OK');
