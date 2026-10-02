/**
 * Probe Alpha workspaces for M8-1A arm (read-only).
 * node scripts/_tmp-m8-1a-find-workspace.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
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
const adminAuth = JSON.parse(readFileSync(join(root, '.tools/alpha-runtime/admin-auth.json'), 'utf8'));

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: '116.62.198.184' }] },
});
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});

const cmds = [
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT column_name FROM information_schema.columns WHERE table_name='Project' ORDER BY ordinal_position"`,
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT column_name FROM information_schema.columns WHERE table_name='User' AND column_name ILIKE '%role%' OR (table_name='User' AND column_name IN ('email','id','platformRole'))"`,
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id || '|' || email || '|' || COALESCE(\\"platformRole\\",'') FROM \\"User\\" WHERE email='${adminAuth.email.replace(/'/g, "''")}' LIMIT 3"`,
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT p.id || '|' || COALESCE(p.name,'') || '|' || p.\\"workspaceId\\" FROM \\"Project\\" p WHERE p.name ILIKE '%ceshi%' OR p.name ILIKE '%web%' ORDER BY p.\\"createdAt\\" DESC LIMIT 30"`,
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT w.id || '|' || COALESCE(w.name,'') || '|' || u.email || '|' || COALESCE(u.\\"platformRole\\",'') FROM \\"Workspace\\" w JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE u.email='${adminAuth.email.replace(/'/g, "''")}' ORDER BY w.\\"createdAt\\" ASC LIMIT 20"`,
];

for (const [i, cmd] of cmds.entries()) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: 30000 });
  console.log(`--- ${i} exit=${r.exitCode} ---`);
  console.log(String(r.stdout || '').trim().slice(0, 2000));
  console.log(String(r.stderr || '').trim().slice(0, 500));
}

await runner.disconnect();
await prisma.$disconnect();
