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
const server = await prisma.serverInstance.findFirst({ where: { id: 'cmuma9i480001rij49yv4yw2q' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});
const cmds = [
  'df -h / | head -3',
  'du -sh /opt/launchos/tmp/* 2>/dev/null | sort -h | tail -40',
  "podman images --format '{{.Repository}}:{{.Tag}} {{.Size}} {{.ID}}' | head -60",
  "podman ps -a --format '{{.Names}} {{.Status}} {{.Image}}' | head -40",
  'ls -lah /opt/launchos/tmp/*.tar 2>/dev/null | head -30; echo ---; du -sh /var/lib/containers 2>/dev/null; du -sh /home/*/.local/share/containers 2>/dev/null',
];
for (const c of cmds) {
  const r = await runner.execute(shellCommand(c), { timeoutMs: 90000 });
  console.log('====', c);
  console.log(((r.stdout || '') + (r.stderr || '')).slice(0, 6000));
}
await runner.disconnect();
await prisma.$disconnect();
