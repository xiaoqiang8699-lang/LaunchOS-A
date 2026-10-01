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
echo ===LR_COUNT===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc 'SELECT count(*) FROM "LaunchRun";'
echo ===LR_LATEST===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c 'SELECT id, status, "currentStage", "currentStep", "failureCode", left(coalesce("failureMessage", '"'"''"'"'), 200), "projectId", "updatedAt"::text FROM "LaunchRun" ORDER BY "updatedAt" DESC LIMIT 15;'
echo ===FOCUS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c 'SELECT id, status, "currentStage", "currentStep", "failureCode", left(coalesce("failureMessage",'"'"''"'"'),240) FROM "LaunchRun" WHERE id='"'"'cmunhwddb0019rl01fzipihgn'"'"';'
echo ===STEPS_LAST_FAIL===
# pick most recent launch that is not SUCCESS or the latest failed snapshot via steps
LR=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc 'SELECT id FROM "LaunchRun" WHERE status='"'"'FAILED'"'"' OR ("failureCode" IS NOT NULL AND "failureCode" <> '"'"''"'"') ORDER BY "updatedAt" DESC LIMIT 1;')
echo LR=$LR
if [ -n "$LR" ]; then
  podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepType\\", status, decision, coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),180), \\"executionOrder\\" FROM \\"LaunchRunStep\\" WHERE \\"launchRunId\\"='$LR' ORDER BY \\"executionOrder\\";"
fi
echo ===DEP_DETAIL===
DEP=cmunoy33y005rrl01dnkps3rp
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),240), coalesce(\\"deployableUnitId\\",''), \\"projectId\\" FROM \\"Deployment\\" WHERE id='$DEP';"
echo ===DEP_STEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepKey\\", status, left(coalesce(\\"errorMessage\\",''),300) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='$DEP' ORDER BY \\"createdAt\\";"
echo ===DEP_LOGS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT left(message,400) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='$DEP' ORDER BY \\"createdAt\\" ASC LIMIT 40;"
echo ===WEB_BUILD_FAIL===
DEP2=cmuno68pb001xrl013r4iu14i
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepKey\\", status, left(coalesce(\\"errorMessage\\",''),300) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='$DEP2' ORDER BY \\"createdAt\\";"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT left(message,400) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='$DEP2' ORDER BY \\"createdAt\\" ASC LIMIT 50;"
echo ===ALPHA_SESS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c 'SELECT id, status, coalesce("primaryFailureCode",'"'"''"'"'), coalesce("blockedStage",'"'"''"'"'), "updatedAt"::text FROM "AlphaTestSession" ORDER BY "updatedAt" DESC LIMIT 8;'
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT column_name FROM information_schema.columns WHERE table_name='AlphaTestSession' ORDER BY ordinal_position;"
`;
await runner.writeTextFile('/opt/launchos/bin/step32-deep-fail.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step32-deep-fail.sh && /opt/launchos/bin/step32-deep-fail.sh'),
  { timeoutMs: 90000 },
);
const out = r.stdout || r.stderr || '';
writeFileSync(join(root, '.tools/alpha-runtime/step32-deep-fail.txt'), out);
console.log(out.slice(0, 15000));
await runner.disconnect();
await prisma.$disconnect();
