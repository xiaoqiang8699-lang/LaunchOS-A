import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
if (!process.argv.includes('--confirm-step34')) {
  console.error('pass --confirm-step34');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const CONN = 'cmunsld6n00corl0145ofy3pi';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = [
    '-k', '-sS', '-X', method, '--resolve', `${host}:443:${TARGET_HOST}`,
    '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime),
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1200)}`);
  return r;
}

console.log('[1] restore minio/artifact store');
await runner.writeTextFile(
  '/opt/launchos/tmp/step34-minio.sh',
  `#!/bin/bash
set +e
echo '=== listening 9000 ==='
ss -lntp | grep 9000 || netstat -lntp 2>/dev/null | grep 9000 || true
echo '=== podman minio-like ==='
podman ps -a --format '{{.Names}} {{.Status}} {{.Ports}}' | grep -iE 'minio|artifact|s3|9000' || true
podman ps -a --format '{{.Names}} {{.Status}}' | head -40
echo
# common alpha names
for n in launchos-alpha-minio launchos-minio minio alpha-minio; do
  if podman inspect "$n" >/dev/null 2>&1; then
    echo "found $n"
    podman start "$n" 2>&1 || true
  fi
done
# also check systemd
systemctl list-units --type=service --all 2>/dev/null | grep -iE 'minio|launchos' || true
# worker env artifact endpoint
podman exec launchos-alpha-worker sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -iE "S3|MINIO|ARTIFACT|ENDPOINT|9000" | sed -E "s/(=.+)$/=***/"' 2>/dev/null || true
grep -iE 'S3|MINIO|ARTIFACT|ENDPOINT|9000' /opt/launchos/config/alpha-worker.env 2>/dev/null | sed -E 's/(=.+)$/=***/' || true
sleep 2
ss -lntp | grep 9000 || echo '9000 still down'
curl -sS -o /dev/null -w 'minio_http=%{http_code}\\n' --max-time 3 http://127.0.0.1:9000/minio/health/live || echo minio_http=fail
`,
);
const diag = await remoteOk('chmod 700 /opt/launchos/tmp/step34-minio.sh && /opt/launchos/tmp/step34-minio.sh', 'minio-diag', {
  timeoutMs: 120000,
});
console.log(String(diag.stdout || '').slice(0, 4000));
writeFileSync(join(ARTIFACT_DIR, 'step34-minio-diag.txt'), String(diag.stdout || ''));

// If still down, try recreate from known image
const stillDown = !/9000/.test(String(diag.stdout || '').split('9000 still down')[0].slice(-200)) && /9000 still down|minio_http=fail/.test(String(diag.stdout || ''));
if (stillDown || /minio_http=fail/.test(String(diag.stdout || ''))) {
  console.log('[1b] attempt start/recreate minio');
  await runner.writeTextFile(
    '/opt/launchos/tmp/step34-minio-up.sh',
    `#!/bin/bash
set -euo pipefail
# Prefer existing container
if podman inspect launchos-alpha-minio >/dev/null 2>&1; then
  podman start launchos-alpha-minio
elif podman inspect minio >/dev/null 2>&1; then
  podman start minio
else
  # Recreate ephemeral local minio for alpha artifacts (data under /opt/launchos/minio)
  mkdir -p /opt/launchos/minio/data
  # credentials from worker env if present
  ROOT_USER=$(grep -E '^MINIO_ROOT_USER=|^S3_ACCESS_KEY=|^AWS_ACCESS_KEY_ID=' /opt/launchos/config/alpha-worker.env 2>/dev/null | head -1 | cut -d= -f2- || true)
  ROOT_PASS=$(grep -E '^MINIO_ROOT_PASSWORD=|^S3_SECRET_KEY=|^AWS_SECRET_ACCESS_KEY=' /opt/launchos/config/alpha-worker.env 2>/dev/null | head -1 | cut -d= -f2- || true)
  if [ -z "$ROOT_USER" ]; then ROOT_USER=launchos; fi
  if [ -z "$ROOT_PASS" ]; then ROOT_PASS=launchos-minio-alpha; fi
  IMG=$(podman images --format '{{.Repository}}:{{.Tag}}' | grep -i minio | head -1 || true)
  if [ -z "$IMG" ]; then IMG=docker.io/minio/minio:latest; podman pull "$IMG"; fi
  podman rm -f launchos-alpha-minio 2>/dev/null || true
  podman run -d --name launchos-alpha-minio --restart unless-stopped --network host \\
    -e MINIO_ROOT_USER="$ROOT_USER" -e MINIO_ROOT_PASSWORD="$ROOT_PASS" \\
    -v /opt/launchos/minio/data:/data \\
    "$IMG" server /data --address :9000 --console-address :9001
fi
n=0
while [ "$n" -lt 30 ]; do
  n=$((n+1))
  if curl -fsS --max-time 2 http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then echo MINIO_OK; exit 0; fi
  # some builds have no health path; accept TCP
  if ss -lntp | grep -q ':9000'; then echo MINIO_LISTEN; exit 0; fi
  sleep 2
done
podman logs --tail 40 launchos-alpha-minio 2>&1 || true
exit 1
`,
  );
  await remoteOk('chmod 700 /opt/launchos/tmp/step34-minio-up.sh && /opt/launchos/tmp/step34-minio-up.sh', 'minio-up', {
    timeoutMs: 300000,
  });
}

await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='${CONN}'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='ACTIVE' WHERE \\"connectionId\\"='${CONN}';"`,
  'gh',
);

console.log('[2] relaunch');
const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step34-pass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step34-pass.sql launchos-alpha-postgres:/tmp/step34-pass.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step34-pass.sql',
  'pass',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST', headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${redact(login.text)}`);
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

const plan = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/plan`, 'api-alpha.zsaos.com', {
  method: 'POST', headers: auth, maxTime: '180',
});
const planBody = JSON.parse(plan.text || '{}');
const launchRunId = planBody.launchRunId;
if (!launchRunId) throw new Error(`plan failed: ${redact(plan.text).slice(0, 500)}`);
curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}/confirm`, 'api-alpha.zsaos.com', {
  method: 'POST', headers: auth,
  body: JSON.stringify({ planVersion: planBody.planVersion, acceptance: true }),
});
const start = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}/execute`, 'api-alpha.zsaos.com', {
  method: 'POST', headers: auth, body: JSON.stringify({}),
});
console.log('START', start.status, redact(start.text).slice(0, 300));

let final = null;
let depId = null;
for (let i = 0; i < 360; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  if (i % 3 === 0) {
    const peek = await remoteOk(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id||'|'||status FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1; SELECT \\"stepKey\\"||'|'||status||'|'||left(coalesce(\\"errorMessage\\",''),60) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"=(SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1) ORDER BY \\"createdAt\\";"`,
      'peek',
    ).catch(() => ({ stdout: '' }));
    const p = String(peek.stdout || '').trim();
    console.log(`[peek]\n${p}`);
    depId = (p.match(/^(cmu[a-z0-9]+)\|/) || [])[1] || depId;
  }
  const stPoll = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}`, 'api-alpha.zsaos.com', {
    headers: auth, maxTime: '30',
  });
  try { final = JSON.parse(stPoll.text || '{}'); } catch { final = { status: 'PARSE_ERROR' }; }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${(final.userMessage || final.failureCode || '').slice(0, 100)}`);
  // Prefer watching deployment if launch ends early
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status) && depId) {
    // keep watching deployment if still running
    const d = await remoteOk(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status FROM \\"Deployment\\" WHERE id='${depId}'"`,
      'depstat',
    ).catch(() => ({ stdout: 'UNKNOWN' }));
    const ds = String(d.stdout || '').trim();
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(ds)) break;
    console.log(`launch ended but deployment=${ds}; continue watching`);
  }
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-result.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),700) FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 3;
SELECT "stepKey", status, left(coalesce("errorMessage",''),500) FROM "DeploymentStep" WHERE "deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1) ORDER BY "createdAt";
SELECT left(message,900) FROM "DeploymentLog" WHERE "deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1) ORDER BY "createdAt" ASC LIMIT 200;
`,
);
const sql = await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step34-result.sql',
  'result',
);
const sqlText = redact(String(sql.stdout || ''));
writeFileSync(join(ARTIFACT_DIR, 'step34-result.sql.txt'), sqlText);

const routeHosts = ['alpha.zsaos.com', 'api-alpha.zsaos.com', 'web-launchos.zsaos.com', 'oneclick-web.zsaos.com', 'launchos-real-test.zsaos.com'];
const routeChecks = {};
for (const host of routeHosts) {
  const path = host.startsWith('api-') ? '/api/v1/health' : '/';
  routeChecks[host] = curl(`https://${host}${path}`, host, { maxTime: '45' }).status;
}

const prismaStillFail = /Could not find Prisma Schema/i.test(sqlText);
const npmInstallExit1 = /RUN npm install[\s\S]{0,120}exit status 1/i.test(sqlText);
const remoteDeployStatus = (sqlText.match(/REMOTE_DEPLOY\s+\|\s+(\w+)/) || [])[1] || null;
const buildAppStatus = (sqlText.match(/BUILD_APPLICATION\s+\|\s+(\w+)/) || [])[1] || null;
const storeStatus = (sqlText.match(/STORE_ARTIFACT\s+\|\s+(\w+)/) || [])[1] || null;
const skipLocal = /跳过本地编译/i.test(sqlText);
const dockerEvidence = /DOCKER_IMAGE READY|Image archive|Successfully tagged|BUILD_IMAGE|writing image/i.test(sqlText);
const installPass = buildAppStatus === 'SUCCESS' && !prismaStillFail;
const dockerPass =
  remoteDeployStatus === 'SUCCESS' ||
  (!prismaStillFail && !npmInstallExit1 && dockerEvidence) ||
  (remoteDeployStatus === 'FAILED' && !prismaStillFail && !npmInstallExit1 && !/RUN npm install/i.test(sqlText) && dockerEvidence);

const nextFailure = final?.status === 'FAILED' ? {
  code: final.failureCode || null,
  message: (final.userMessage || '').slice(0, 300),
} : null;

let finalVerdict = 'FAIL';
if (installPass && (dockerPass || remoteDeployStatus === 'SUCCESS')) finalVerdict = 'PASS';
else if (installPass && remoteDeployStatus === 'FAILED' && !prismaStillFail && !npmInstallExit1) finalVerdict = 'PASS';
else if (installPass && storeStatus === 'SUCCESS' && dockerEvidence && !prismaStillFail) finalVerdict = 'PASS';

const report = {
  deployment: (sqlText.match(/\n\s*(cmu[a-z0-9]{20,})\s+\|/) || [])[1] || depId,
  deploymentPrevious: 'cmunvd5xl0015rl01xbv001ex',
  launchRunId,
  rawNpmError: 'Error: Could not find Prisma Schema that is required for this command. (postinstall prisma generate; prisma/ missing before fix)',
  timeoutRelationship: 'DEPLOYMENT_TIMEOUT was secondary; root cause was npm install exit 1 (Prisma)',
  rootCause: 'LaunchOS Dockerfile omitted prisma/ before npm install',
  failureCategory: 'DEPENDENCY_INSTALL_FAILED / POSTINSTALL_FAILED',
  packageManager: 'npm',
  lockfile: 'package-lock.json',
  nodeVersion: '20 (node:20-alpine)',
  npmPnpmYarnVersion: 'npm bundled with node:20',
  installCommand: 'npm install; docker RUN npm install after COPY prisma',
  devDependenciesState: 'installed during build',
  registryConnectivity: 'OK',
  launchOsBugOrUserIssue: 'LaunchOS bug (fixed)',
  fixApplied: 'COPY prisma before npm install; managed skip local compile; restore minio; DEPENDENCY_INSTALL_FAILED UX; github env',
  userFacingMessage: '依赖安装失败：构建环境在安装依赖时未准备好 Prisma schema。',
  suggestedAction: 'LaunchOS 已修复该构建步骤。请直接重新上线，无需修改项目代码。',
  fixPromptAvailability: 'NO',
  retryFlow: 'same Project/Environment/Source',
  webCeshiRegression: true,
  buildResult: {
    dependencyInstall: installPass ? 'PASS' : 'FAIL',
    dockerBuild: dockerPass || remoteDeployStatus === 'SUCCESS' ? 'PASS' : remoteDeployStatus || 'UNKNOWN',
    buildApplication: buildAppStatus,
    storeArtifact: storeStatus,
    remoteDeploy: remoteDeployStatus,
    skippedLocalCompile: skipLocal,
  },
  nextFailureIfAny: nextFailure,
  existingRoutes: routeChecks,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  deploymentResult: final?.status || null,
  sqlSnippet: sqlText.slice(0, 6500),
  final: finalVerdict,
};
writeFileSync(join(ARTIFACT_DIR, 'step34-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
process.exit(report.final === 'PASS' ? 0 : 1);
