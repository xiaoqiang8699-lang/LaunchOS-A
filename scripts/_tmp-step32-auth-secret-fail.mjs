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

const LR = 'cmunsomd000e9rl01l54fl7vk';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';

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
echo ===PROJECT===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT p.id, p.name, p.\\"workspaceId\\", w.name, u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"
echo ===LAUNCH===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", \\"failureCode\\", \\"failureMessage\\", \\"confirmationId\\", \\"updatedAt\\"::text FROM \\"LaunchRun\\" WHERE id='${LR}';"
echo ===DEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),240), coalesce(\\"deployableUnitId\\",''), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 8;"
echo ===REQS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, key, required::text, coalesce(\\"deployableUnitId\\",''), coalesce(label,'') FROM \\"RuntimeConfigRequirement\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY key;"
echo ===RCV===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT key, \\"scopeType\\"::text, \\"scopeId\\", coalesce(\\"deployableUnitId\\",'') FROM \\"RuntimeConfigValue\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY key;"
echo ===UNITS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, name, type::text, coalesce(\\"rootPath\\",'') FROM \\"DeployableUnit\\" WHERE \\"projectId\\"='${PROJECT}';"
echo ===API_LOG===
podman logs --tail 120 launchos-alpha-api 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,})[=:][^ ]+/\\1=***/gi' | grep -E 'AUTH_SECRET|运行配置|cmunsomd|cmunsm2|DEPLOY|FAILED|managed' | tail -40
echo ===SESSIONS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, \\"userId\\", coalesce(\\"projectId\\",''), coalesce(\\"launchRunId\\",''), \\"sessionStatus\\", coalesce(\\"primaryFailureCode\\",''), coalesce(\\"blockedStage\\",''), coalesce(\\"blockedStep\\",''), \\"updatedAt\\"::text FROM \\"AlphaTestSession\\" WHERE \\"projectId\\"='${PROJECT}' OR \\"launchRunId\\"='${LR}' ORDER BY \\"updatedAt\\" DESC LIMIT 5;"
`;
await runner.writeTextFile('/opt/launchos/bin/step32-auth-secret-fail.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step32-auth-secret-fail.sh && /opt/launchos/bin/step32-auth-secret-fail.sh'),
  { timeoutMs: 90000 },
);
const out = r.stdout || r.stderr || '';
writeFileSync(join(root, '.tools/alpha-runtime/step32-auth-secret-fail.txt'), out);
console.log(out);
await runner.disconnect();
await prisma.$disconnect();
