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
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const DEP = 'cmuo1j5k5001vrl01aio07lf3';

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken|AUTH_SECRET)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
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

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 2500)}`);
  return r;
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step35-hang.sh',
  `#!/bin/bash
set +e
echo '=== now / deployment age ==='
date -u
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id||'|'||status||'|'||coalesce(\\"currentStage\\",'')||'|'||coalesce(\\"failureCode\\",'')||'|'||\\"lastActivityAt\\"||'|'||extract(epoch from (now()-\\"lastActivityAt\\")) FROM \\"Deployment\\" WHERE id='${DEP}';"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT \\"stepKey\\", status, \\"startedAt\\", \\"finishedAt\\", left(coalesce(\\"errorMessage\\",''),200) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='${DEP}' ORDER BY \\"createdAt\\";"
echo
echo '=== latest deployment logs ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT \\"createdAt\\", level, left(message,400) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${DEP}' ORDER BY \\"createdAt\\" DESC LIMIT 40;"
echo
echo '=== launch runs after 11:40 ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT id, status, \\"currentStage\\"::text, \\"currentStep\\", \\"createdAt\\", \\"updatedAt\\" FROM \\"LaunchRun\\" WHERE \\"projectId\\"='cmunsm2lk00ctrl01nnu1pwyd' AND \\"createdAt\\" > '2026-09-30 11:40:00' ORDER BY \\"createdAt\\" DESC;"
echo
echo '=== service instances ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT id, status, \\"healthStatus\\", port, \\"externalPort\\", left(coalesce(\\"containerId\\",''),20), \\"updatedAt\\" FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='cmunsm2lk00ctrl01nnu1pwyd' ORDER BY \\"createdAt\\" DESC LIMIT 5;"
echo
echo '=== upload/tmp artifacts ==='
ls -lah /opt/launchos/artifacts/launchos-artifacts/deployments/${DEP}/ 2>/dev/null || ls -lah /tmp/launchos-image-archives/ 2>/dev/null | head
ls -lah /tmp/launchos-runtime/ 2>/dev/null | head
find /tmp /opt/launchos/artifacts -name '*cmuo1j5k*' 2>/dev/null | head -20
echo
echo '=== worker recent ==='
podman logs --since 40m launchos-alpha-worker 2>&1 | grep -iE '${DEP}|UPLOAD|upload|load |podman run|REMOTE_DEPLOY|stall|error|Error|ECONN|timeout|candidate|image archive' | sed -E 's/(AUTH_SECRET|PASSWORD|SECRET|TOKEN|DATABASE_URL)=[^ ]+/\\1=***/g' | tail -80
echo
echo '=== AUTH_SECRET present in prev container env? ==='
podman exec launchos-cmuo01mvg0 sh -c 'if [ -n "$AUTH_SECRET" ]; then echo AUTH_SECRET=present; else echo AUTH_SECRET=missing; fi; echo AUTH_URL=$AUTH_URL; echo PORT=$PORT; echo HOST=$HOST; echo NODE_ENV=$NODE_ENV'
echo
echo '=== runtime config keys in DB (no values) ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT key, \\"isSecret\\", \\"updatedAt\\" FROM \\"RuntimeConfig\\" WHERE \\"projectId\\"='cmunsm2lk00ctrl01nnu1pwyd' OR \\"deployableUnitId\\"='cmunsmcpc00d2rl0184kdxdb3' ORDER BY key;" 2>/dev/null || podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "\\dt *config*"
echo
echo '=== dig launchos.app ==='
dig +short web-ceshi.launchos.app A 2>/dev/null || nslookup web-ceshi.launchos.app 8.8.8.8 2>&1 | tail -20
dig +short launchos.app NS 2>/dev/null | head
echo
echo '=== gateway cert for host ==='
grep -A25 'server_name web-ceshi.launchos.app' /opt/launchos/gateway/active/launchos-routes.conf | head -40
`,
);

const r = await remoteOk('chmod 700 /opt/launchos/tmp/step35-hang.sh && /opt/launchos/tmp/step35-hang.sh', 'hang', {
  timeoutMs: 180000,
});
const out = redact(String(r.stdout || '') + '\n' + String(r.stderr || ''));
writeFileSync(join(ARTIFACT_DIR, 'step35-hang.txt'), out);
console.log(out.slice(0, 14000));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
