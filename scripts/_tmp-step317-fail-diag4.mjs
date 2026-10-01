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
});

await runner.writeTextFile(
  '/opt/launchos/bin/step317-fail-diag4.sh',
  `#!/bin/bash
set -uo pipefail
echo ===LAUNCH===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),240), coalesce(\\"confirmationId\\",'') FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn';"
echo ===DEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),200), coalesce(\\"idempotencyKey\\",''), coalesce(\\"deployableUnitId\\",''), \\"createdAt\\"::text, \\"updatedAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"createdAt\\" DESC LIMIT 6;"
DEP=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"createdAt\\" DESC LIMIT 1;")
echo DEP=\$DEP
echo ===STEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepKey\\", status, left(coalesce(\\"errorMessage\\",''),300) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='\$DEP' ORDER BY \\"createdAt\\";"
echo ===LOGS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT left(message,400) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='\$DEP' ORDER BY \\"createdAt\\" ASC LIMIT 40;"
echo ===WORKER_ENV===
podman exec launchos-alpha-worker /bin/sh -c 'node -e "console.log(JSON.stringify({ARTIFACT_STORE:process.env.ARTIFACT_STORE,LOCAL_ARTIFACT_ROOT:process.env.LOCAL_ARTIFACT_ROOT,MINIO_ENDPOINT:process.env.MINIO_ENDPOINT,hasLocal:require(\\"fs\\").readFileSync(\\"/app/packages/deployment/dist/artifacts/minio-artifact-store.js\\",\\"utf8\\").includes(\\"useLocalArtifactStore\\")}))"'
echo ===WORKER_LOG===
podman logs --tail 80 launchos-alpha-worker 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,})[=:][^ ]+/\\1=***/gi' | tail -60
echo ===API_MARKERS===
podman exec launchos-alpha-api /bin/sh -c 'grep -c "alpha-managed-" /app/apps/api/dist/launch/launch.service.js; grep -c "idempotencyKey: null" /app/apps/api/dist/deployments/deployments.service.js; grep -c confirmationId /app/apps/api/dist/launch/launch.service.js'
`,
);

const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-fail-diag4.sh && /opt/launchos/bin/step317-fail-diag4.sh'),
  { timeoutMs: 90000 },
);
const out = redact((r.stdout || '') + (r.stderr || ''));
writeFileSync(join(root, '.tools/alpha-runtime/step317-fail-diag4.txt'), out);
console.log(out.slice(0, 14000));
await runner.disconnect();
await prisma.$disconnect();
