import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

mkdirSync(join(root, '.tools/alpha-runtime'), { recursive: true });

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
echo ===RECENT_FAILED_LAUNCH===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"currentStage\\",''), coalesce(\\"currentStep\\",''), coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),220), \\"projectId\\", \\"updatedAt\\"::text FROM \\"LaunchRun\\" WHERE status='FAILED' ORDER BY \\"updatedAt\\" DESC LIMIT 10;"
echo ===RECENT_LAUNCH_ANY===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"currentStage\\",''), coalesce(\\"currentStep\\",''), coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),160), \\"projectId\\", \\"updatedAt\\"::text FROM \\"LaunchRun\\" ORDER BY \\"updatedAt\\" DESC LIMIT 12;"
echo ===RECENT_FAILED_DEP===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),200), coalesce(\\"deployableUnitId\\",''), \\"projectId\\", \\"createdAt\\"::text FROM \\"Deployment\\" WHERE status='FAILED' ORDER BY \\"createdAt\\" DESC LIMIT 10;"
echo ===ALPHA_TABLES===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ILIKE '%Alpha%' OR table_name ILIKE '%Friction%' OR table_name ILIKE '%Session%') ORDER BY 1;"
`;
await runner.writeTextFile('/opt/launchos/bin/step32-find-fail.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step32-find-fail.sh && /opt/launchos/bin/step32-find-fail.sh'),
  { timeoutMs: 90000 },
);
const out = r.stdout || r.stderr || '';
writeFileSync(join(root, '.tools/alpha-runtime/step32-find-fail.txt'), out);
console.log(out);
await runner.disconnect();
await prisma.$disconnect();
