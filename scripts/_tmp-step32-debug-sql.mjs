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

await runner.writeTextFile(
  '/opt/launchos/tmp/step32-verify.sql',
  `SELECT id, status FROM "LaunchRun" WHERE id='cmunhwddb0019rl01fzipihgn';
SELECT id, status FROM "LaunchRun" WHERE status='SUCCESS' ORDER BY "updatedAt" DESC LIMIT 3;
SELECT status, "failureCode", left("failureMessage",80),
  "planSnapshot"->'failurePresentation'->>'category',
  "planSnapshot"->'failurePresentation'->>'stageLabel'
FROM "LaunchRun" WHERE id='cmunsomd000e9rl01l54fl7vk';
SELECT name, metadata->>'failureCategory', metadata->>'failureStage', metadata->>'userBlocked'
FROM "ProductEvent"
WHERE name='ALPHA_FRICTION_NOTED' AND metadata->>'note' LIKE 'External Alpha P1 — Deployment failure%'
ORDER BY "createdAt" DESC LIMIT 1;
`,
);

const r = await runner.execute(
  shellCommand(
    'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step32-verify.sql',
  ),
  { timeoutMs: 60000 },
);
console.log('CODE', r.exitCode);
console.log(r.stdout);
console.error(r.stderr);
await prisma.$disconnect();
await runner.disconnect();
