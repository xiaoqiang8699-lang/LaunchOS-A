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
  '/opt/launchos/bin/step317-web-dep-diag.sh',
  `#!/bin/bash
set +e
P=cmunhwais0003rl01wqj1qy11
W=cmunhwc9k000drl01gxu1qwq2
A=cmunhwc9g000brl01bgid72o7
echo ===WEB_DEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),160), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='$P' AND \\"deployableUnitId\\"='$W' ORDER BY \\"createdAt\\" DESC LIMIT 10;"
echo ===API_DEPS_RECENT===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"idempotencyKey\\",''), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='$P' AND \\"deployableUnitId\\"='$A' ORDER BY \\"createdAt\\" DESC LIMIT 5;"
echo ===ALL_ROUTES===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, \\"projectId\\", hostname, status, coalesce(\\"unitId\\",'') FROM \\"GatewayRoute\\" ORDER BY \\"updatedAt\\" DESC LIMIT 20;"
echo ===ROUTE_COLS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT column_name FROM information_schema.columns WHERE table_name='GatewayRoute' ORDER BY ordinal_position;"
echo ===DOMAIN_COLS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT column_name FROM information_schema.columns WHERE table_name='ApplicationDomain' ORDER BY ordinal_position;"
echo ===LAUNCH_STEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepType\\", status, decision, coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),120) FROM \\"LaunchRunStep\\" WHERE \\"launchRunId\\"='cmunhwddb0019rl01fzipihgn' ORDER BY \\"executionOrder\\";"
echo ===RCV_WEB===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT key, \\"scopeType\\"::text, \\"scopeId\\", coalesce(\\"deployableUnitId\\",'') FROM \\"RuntimeConfigValue\\" WHERE \\"projectId\\"='$P' AND (\\"deployableUnitId\\"='$W' OR key ILIKE '%API%' OR key ILIKE '%SENTRY%') ORDER BY key;"
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-web-dep-diag.sh && /opt/launchos/bin/step317-web-dep-diag.sh'),
  { timeoutMs: 60000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-web-dep-diag.txt'), r.stdout || r.stderr || '');
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
