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
const TARGET_HOST = '116.62.198.184';
const WS = 'cmukwvk6x0004ri90zeb46zpc';

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
const q = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT s.id || '|' || pl.code || '|' || pl.\\"maxProjects\\"::text || '|' || COALESCE(s.\\"planVersionId\\",'') || '|' || COALESCE(pv.\\"limitsJson\\"::text,'') || '|' || s.status FROM \\"Subscription\\" s JOIN \\"Plan\\" pl ON pl.id=s.\\"planId\\" LEFT JOIN \\"PlanVersion\\" pv ON pv.id=s.\\"planVersionId\\" WHERE s.\\"workspaceId\\"='${WS}' ORDER BY s.\\"createdAt\\" DESC LIMIT 3"`,
  ),
  { timeoutMs: 60000 },
);
console.log(q.stdout || q.stderr);
writeFileSync(join(root, '.tools/alpha-runtime/ux3-free-sub.txt'), q.stdout || '');
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
