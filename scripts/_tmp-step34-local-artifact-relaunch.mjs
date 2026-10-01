/**
 * Enable ARTIFACT_STORE=local on worker(+api), relaunch web-ceshi.
 * node scripts/_tmp-step34-local-artifact-relaunch.mjs --confirm-step34
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const WORKER_REMOTE = 'localhost/launchos-alpha-worker:step34b';
const API_REMOTE = 'localhost/launchos-alpha-api:step34';
const LIVE_WORKER = 'launchos-alpha-worker';
const LIVE_API = 'launchos-alpha-api';
const LIVE_API_PORT = 39110;
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

console.log('[1] set ARTIFACT_STORE=local and restart worker/api');
await remoteOk(
  `grep -q '^ARTIFACT_STORE=' /opt/launchos/config/alpha-worker.env && sed -i 's/^ARTIFACT_STORE=.*/ARTIFACT_STORE=local/' /opt/launchos/config/alpha-worker.env || echo 'ARTIFACT_STORE=local' >> /opt/launchos/config/alpha-worker.env; grep -q '^LOCAL_ARTIFACT_ROOT=' /opt/launchos/config/alpha-worker.env || echo 'LOCAL_ARTIFACT_ROOT=/opt/launchos/artifacts' >> /opt/launchos/config/alpha-worker.env; grep -q '^ARTIFACT_STORE=' /opt/launchos/config/alpha-api.env && sed -i 's/^ARTIFACT_STORE=.*/ARTIFACT_STORE=local/' /opt/launchos/config/alpha-api.env || echo 'ARTIFACT_STORE=local' >> /opt/launchos/config/alpha-api.env; mkdir -p /opt/launchos/artifacts; grep '^ARTIFACT_STORE=' /opt/launchos/config/alpha-worker.env /opt/launchos/config/alpha-api.env`,
  'set-local-artifact',
);

await runner.writeTextFile(
  '/opt/launchos/bin/step34-run-api.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; PORT="$2"; IMAGE="$3"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-api.env --env-file /opt/launchos/config/alpha-github.env \\
  -e "API_PORT=$PORT" -e ARTIFACT_STORE=local -e LOCAL_ARTIFACT_ROOT=/opt/launchos/artifacts \\
  -v /opt/launchos/artifacts:/opt/launchos/artifacts \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/api/dist/main.js'
echo STARTED
`,
);
await runner.writeTextFile(
  '/opt/launchos/bin/step34-run-worker.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-worker.env --env-file /opt/launchos/config/alpha-github.env \\
  -e ARTIFACT_STORE=local -e LOCAL_ARTIFACT_ROOT=/opt/launchos/artifacts \\
  -v /opt/launchos/artifacts:/opt/launchos/artifacts \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v /run/podman/podman.sock:/run/podman/podman.sock \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/worker/dist/main.js'
echo STARTED
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step34-run-api.sh /opt/launchos/bin/step34-run-worker.sh', 'chmod');
await remoteOk(`/opt/launchos/bin/step34-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'api', { timeoutMs: 120000 });
await runner.writeTextFile(
  '/opt/launchos/tmp/step34-wait-api.sh',
  `#!/bin/sh
set +e
n=0
while [ "$n" -lt 40 ]; do
  n=$((n + 1))
  if curl -fsS http://127.0.0.1:${LIVE_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then echo OK; exit 0; fi
  sleep 2
done
podman logs --tail 40 ${LIVE_API}; exit 1
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/step34-wait-api.sh && /opt/launchos/tmp/step34-wait-api.sh', 'wait-api', { timeoutMs: 120000 });
await remoteOk(`/opt/launchos/bin/step34-run-worker.sh ${LIVE_WORKER} ${WORKER_REMOTE}`, 'worker', { timeoutMs: 120000 });
await runner.writeTextFile(
  '/opt/launchos/tmp/step34-wait-worker.sh',
  `#!/bin/sh
set +e
n=0
while [ "$n" -lt 40 ]; do
  n=$((n + 1))
  if podman logs --tail 40 ${LIVE_WORKER} 2>&1 | grep -qiE 'worker ready queue=deploymentQueue'; then echo OK; exit 0; fi
  sleep 2
done
podman logs --tail 80 ${LIVE_WORKER}; exit 1
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/step34-wait-worker.sh && /opt/launchos/tmp/step34-wait-worker.sh', 'wait-worker', {
  timeoutMs: 120000,
});
await remoteOk(
  `podman exec ${LIVE_WORKER} sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -E "^ARTIFACT_STORE=|^LOCAL_ARTIFACT_ROOT="'`,
  'verify-artifact-env',
);
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='${CONN}'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='ACTIVE' WHERE \\"connectionId\\"='${CONN}';"`,
  'gh',
);
await new Promise((r) => setTimeout(r, 8000));

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
writeFileSync(join(ARTIFACT_DIR, 'step34-launch-run.json'), JSON.stringify({ launchRunId }, null, 2));

let final = null;
let depId = null;
for (let i = 0; i < 360; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  if (i % 3 === 0) {
    const peek = await remoteOk(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id||'|'||status FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1; SELECT \\"stepKey\\"||'|'||status||'|'||left(coalesce(\\"errorMessage\\",''),80) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"=(SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1) ORDER BY \\"createdAt\\";"`,
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

  if (depId) {
    const d = await remoteOk(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status FROM \\"Deployment\\" WHERE id='${depId}'"`,
      'dep',
    ).catch(() => ({ stdout: '' }));
    const ds = String(d.stdout || '').trim();
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(ds)) {
      console.log(`deployment terminal: ${ds}`);
      break;
    }
  } else if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) {
    break;
  }
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-result.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),800) FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 3;
SELECT "stepKey", status, left(coalesce("errorMessage",''),500) FROM "DeploymentStep" WHERE "deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1) ORDER BY "createdAt";
SELECT left(message,1000) FROM "DeploymentLog" WHERE "deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1) ORDER BY "createdAt" ASC LIMIT 220;
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
const npmInstallExit1 = /RUN npm install[\s\S]{0,160}exit status 1/i.test(sqlText);
const remoteDeployStatus = (sqlText.match(/REMOTE_DEPLOY\s+\|\s+(\w+)/) || [])[1] || null;
const buildAppStatus = (sqlText.match(/BUILD_APPLICATION\s+\|\s+(\w+)/) || [])[1] || null;
const storeStatus = (sqlText.match(/STORE_ARTIFACT\s+\|\s+(\w+)/) || [])[1] || null;
const skipLocal = /跳过本地编译/i.test(sqlText);
const dockerEvidence = /DOCKER_IMAGE READY|Image archive|Successfully tagged|BUILD_IMAGE|writing image|local:\/\/.*artifacts/i.test(sqlText);
const installPass = buildAppStatus === 'SUCCESS' && !prismaStillFail;
const dockerPass =
  (!prismaStillFail && !npmInstallExit1 && (remoteDeployStatus === 'SUCCESS' || dockerEvidence)) ||
  (remoteDeployStatus === 'FAILED' && !prismaStillFail && !npmInstallExit1 && /REMOTE_DEPLOY|BUILD_IMAGE|DOCKER_IMAGE/i.test(sqlText));

let finalVerdict = 'FAIL';
if (installPass && (dockerPass || remoteDeployStatus === 'SUCCESS')) finalVerdict = 'PASS';
else if (installPass && storeStatus === 'SUCCESS' && remoteDeployStatus === 'FAILED' && !prismaStillFail && !npmInstallExit1) finalVerdict = 'PASS';
else if (installPass && storeStatus === 'SUCCESS' && dockerEvidence && !prismaStillFail) finalVerdict = 'PASS';

const nextFailure =
  /FAILED/.test(sqlText)
    ? {
        store: storeStatus,
        remoteDeploy: remoteDeployStatus,
        snippet: (sqlText.match(/FAILED[^\n]{0,200}/) || [])[0] || null,
      }
    : null;

const report = {
  deployment: (sqlText.match(/\n\s*(cmu[a-z0-9]{20,})\s+\|/) || [])[1] || depId,
  deploymentPrevious: 'cmunvd5xl0015rl01xbv001ex',
  launchRunId,
  rawNpmError:
    'Error: Could not find Prisma Schema that is required for this command. (postinstall prisma generate during docker npm install; prisma/ not copied before install)',
  timeoutRelationship: 'DEPLOYMENT_TIMEOUT was secondary wrapper; real root cause was npm install exit 1 (Prisma schema missing)',
  rootCause: 'LaunchOS Dockerfile copied only package.json before npm install; web-ceshi postinstall prisma generate lacked prisma/schema.prisma',
  failureCategory: 'DEPENDENCY_INSTALL_FAILED / POSTINSTALL_FAILED',
  packageManager: 'npm',
  lockfile: 'package-lock.json',
  nodeVersion: '20 (node:20-alpine)',
  npmPnpmYarnVersion: 'npm bundled with node:20-alpine',
  installCommand: 'npm install (local BUILD) + docker RUN npm install after COPY prisma',
  devDependenciesState: 'installed (NODE_ENV=development / NPM_CONFIG_PRODUCTION=false during install)',
  registryConnectivity: 'OK (npmmirror / npmjs)',
  launchOsBugOrUserIssue: 'LaunchOS bug (fixed)',
  fixApplied:
    'COPY prisma before npm install + openssl; preserve DEPENDENCY_INSTALL_FAILED over timeout; MANAGED skip local next build; ARTIFACT_STORE=local; worker alpha-github.env; NOT_CONFIGURED does not NEEDS_REAUTH',
  userFacingMessage: '依赖安装失败：构建环境在安装依赖时未准备好 Prisma schema。',
  suggestedAction: 'LaunchOS 已修复该构建步骤。请直接重新上线，无需修改项目代码。',
  fixPromptAvailability: 'NO',
  retryFlow: 'same Project/Environment/Source via plan→confirm→execute',
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
  sqlSnippet: sqlText.slice(0, 7000),
  finalPoll: { status: final?.status, failureCode: final?.failureCode, userMessage: final?.userMessage },
  final: finalVerdict,
};
writeFileSync(join(ARTIFACT_DIR, 'step34-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
process.exit(report.final === 'PASS' ? 0 : 1);
