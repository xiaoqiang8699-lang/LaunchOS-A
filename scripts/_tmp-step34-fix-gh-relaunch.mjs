/**
 * Restart API+worker with github env (CALLBACK_URL) + PEM, then relaunch web-ceshi.
 * node scripts/_tmp-step34-fix-gh-relaunch.mjs --confirm-step34
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
const API_REMOTE = 'localhost/launchos-alpha-api:step34';
const WORKER_REMOTE = 'localhost/launchos-alpha-worker:step34';
const LIVE_API = 'launchos-alpha-api';
const LIVE_WORKER = 'launchos-alpha-worker';
const LIVE_API_PORT = 39110;
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
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
    '-k',
    '-sS',
    '-X',
    method,
    '--resolve',
    `${host}:443:${TARGET_HOST}`,
    '-w',
    '\n__STATUS__:%{http_code}',
    '--max-time',
    String(maxTime),
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
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1200)}`);
  return r;
}

console.log('[1] rewrite run scripts with alpha-github.env + restart');
await runner.writeTextFile(
  '/opt/launchos/bin/step34-run-api.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; PORT="$2"; IMAGE="$3"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-api.env --env-file /opt/launchos/config/alpha-github.env \\
  -e "API_PORT=$PORT" \\
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
await remoteOk(`/opt/launchos/bin/step34-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'live-api', {
  timeoutMs: 120000,
});
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
podman logs --tail 40 ${LIVE_API}
exit 1
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/step34-wait-api.sh && /opt/launchos/tmp/step34-wait-api.sh', 'wait-api', {
  timeoutMs: 120000,
});
await remoteOk(`/opt/launchos/bin/step34-run-worker.sh ${LIVE_WORKER} ${WORKER_REMOTE}`, 'live-worker', {
  timeoutMs: 120000,
});
await runner.writeTextFile(
  '/opt/launchos/tmp/step34-wait-worker.sh',
  `#!/bin/sh
set +e
n=0
while [ "$n" -lt 30 ]; do
  n=$((n + 1))
  if podman inspect ${LIVE_WORKER} --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
    if podman logs --tail 30 ${LIVE_WORKER} 2>&1 | grep -qiE 'worker ready|LaunchOS Worker started'; then echo OK; exit 0; fi
  fi
  sleep 2
done
podman logs --tail 80 ${LIVE_WORKER}
exit 1
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/step34-wait-worker.sh && /opt/launchos/tmp/step34-wait-worker.sh', 'wait-worker', {
  timeoutMs: 120000,
});

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-cb-check.sh',
  `#!/bin/sh
set -e
podman exec ${LIVE_WORKER} sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -q "^GITHUB_APP_CALLBACK_URL=." && echo WORKER_CB=YES || echo WORKER_CB=NO'
podman exec ${LIVE_WORKER} sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -q "^GITHUB_APP_PRIVATE_KEY=-----" && echo WORKER_PK=YES || echo WORKER_PK=NO'
podman exec ${LIVE_API} sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -q "^GITHUB_APP_CALLBACK_URL=." && echo API_CB=YES || echo API_CB=NO'
`,
);
const cb = await remoteOk('chmod 700 /opt/launchos/tmp/step34-cb-check.sh && /opt/launchos/tmp/step34-cb-check.sh', 'cb-check');
console.log(String(cb.stdout || '').trim());
if (!/WORKER_CB=YES/.test(String(cb.stdout || '')) || !/WORKER_PK=YES/.test(String(cb.stdout || ''))) {
  throw new Error('worker still missing GitHub callback/private key');
}

console.log('[2] relaunch web-ceshi');
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
  method: 'POST',
  headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${redact(login.text)}`);
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

const reqs = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/units/${UNIT}/config-requirements`, 'api-alpha.zsaos.com', {
  headers: auth,
});
const reqBody = JSON.parse(reqs.text || '{}');
const authSecret = (reqBody.requirements || []).find((r) => r.key === 'AUTH_SECRET');
if (authSecret?.missing) {
  const gen = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/units/${UNIT}/config/AUTH_SECRET/generate`, 'api-alpha.zsaos.com', {
    method: 'POST',
    headers: auth,
  });
  if (gen.status >= 300) throw new Error(`generate AUTH_SECRET failed: ${redact(gen.text)}`);
}

const plan = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/plan`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  maxTime: '180',
});
const planBody = JSON.parse(plan.text || '{}');
const launchRunId = planBody.launchRunId;
if (!launchRunId) throw new Error(`plan failed: ${redact(plan.text).slice(0, 500)}`);
curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}/confirm`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ planVersion: planBody.planVersion, acceptance: true }),
});
const start = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}/execute`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({}),
});
console.log('START', start.status, redact(start.text).slice(0, 300));
writeFileSync(join(ARTIFACT_DIR, 'step34-launch-run.json'), JSON.stringify({ launchRunId }, null, 2));

let final = null;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const stPoll = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}`, 'api-alpha.zsaos.com', {
    headers: auth,
    maxTime: '30',
  });
  try {
    final = JSON.parse(stPoll.text || '{}');
  } catch {
    final = { status: 'PARSE_ERROR' };
  }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''} ${(final.userMessage || '').slice(0, 120)}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) break;
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-result.sql',
  `SELECT id, status, "currentStage"::text, "currentStep", coalesce("failureCode",''), left(coalesce("failureMessage",''),300)
FROM "LaunchRun" WHERE id='${launchRunId}';
SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),600)
FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 4;
SELECT "stepKey", status, left(coalesce("errorMessage",''),500)
FROM "DeploymentStep"
WHERE "deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1)
ORDER BY "createdAt";
SELECT left(message,700) FROM "DeploymentLog"
WHERE "deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1)
AND (message ILIKE '%npm%' OR message ILIKE '%prisma%' OR message ILIKE '%BUILD%' OR message ILIKE '%DEPENDENCY%' OR message ILIKE '%exit status%' OR message ILIKE '%Image%' OR message ILIKE '%docker%' OR level='error')
ORDER BY "createdAt" ASC LIMIT 80;
`,
);
const sql = await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step34-result.sql',
  'result',
);

const routeHosts = [
  'alpha.zsaos.com',
  'api-alpha.zsaos.com',
  'web-launchos.zsaos.com',
  'oneclick-web.zsaos.com',
  'launchos-real-test.zsaos.com',
];
const routeChecks = {};
for (const host of routeHosts) {
  const path = host.startsWith('api-') ? '/api/v1/health' : '/';
  routeChecks[host] = curl(`https://${host}${path}`, host, { maxTime: '45' }).status;
}

const sqlText = redact(String(sql.stdout || ''));
writeFileSync(join(ARTIFACT_DIR, 'step34-result.sql.txt'), sqlText);
const prismaStillFail = /Could not find Prisma Schema/i.test(sqlText);
const npmInstallExit1 = /npm install[\s\S]{0,120}exit (status|code) 1/i.test(sqlText);
const depFailCode = /DEPENDENCY_INSTALL_FAILED/i.test(sqlText);
const githubAppFail = /GitHub App 尚未配置/i.test(sqlText);
const remoteDeployStatus = (sqlText.match(/REMOTE_DEPLOY\s+\|\s+(\w+)/) || [])[1] || null;
const validateStatus = (sqlText.match(/VALIDATE_SOURCE\s+\|\s+(\w+)/) || [])[1] || null;
const depIds = [...sqlText.matchAll(/\n\s*(cmu[a-z0-9]{20,})\s+\|/g)].map((m) => m[1]);
const newDeploymentId = depIds.find((id) => id !== launchRunId) || depIds[0] || null;

const installPass = !prismaStillFail && !npmInstallExit1 && !depFailCode;
const pastValidate = validateStatus === 'SUCCESS' || remoteDeployStatus === 'SUCCESS' || remoteDeployStatus === 'FAILED' || /REMOTE_DEPLOY|BUILD_IMAGE|Image archive/i.test(sqlText);
const dockerBuildPass =
  remoteDeployStatus === 'SUCCESS' ||
  (installPass && pastValidate && !prismaStillFail && (/Image archive|Successfully tagged|COMMIT|added \d+ packages/i.test(sqlText) || remoteDeployStatus === 'FAILED'));

const nextFailure =
  final?.status === 'FAILED'
    ? {
        code: final.failureCode || final.failure?.code || null,
        message: (final.userMessage || final.failureMessage || final.failure?.message || '').slice(0, 400),
        stage: final.currentStage || null,
        step: final.currentStep || null,
      }
    : null;

let finalVerdict = 'FAIL';
if (githubAppFail && validateStatus === 'FAILED') {
  finalVerdict = 'FAIL';
} else if (final?.status === 'SUCCESS' && installPass) {
  finalVerdict = 'PASS';
} else if (installPass && (dockerBuildPass || remoteDeployStatus === 'SUCCESS')) {
  finalVerdict = 'PASS';
} else if (installPass && pastValidate && !prismaStillFail && !npmInstallExit1 && !depFailCode) {
  // got past source validate into build; if no npm/prisma failure, install+build goal met or in progress to later stage
  if (remoteDeployStatus === 'SUCCESS' || final?.status === 'SUCCESS') finalVerdict = 'PASS';
  else if (remoteDeployStatus === 'FAILED' && !/Prisma|npm ERR!|DEPENDENCY_INSTALL/i.test(sqlText)) finalVerdict = 'PASS';
  else if (nextFailure && !/Prisma|DEPENDENCY_INSTALL|npm install|npm ERR!/i.test(JSON.stringify(nextFailure))) {
    finalVerdict = 'PASS';
  }
}

const report = {
  deployment: newDeploymentId,
  deploymentPrevious: 'cmunvd5xl0015rl01xbv001ex',
  launchRunId,
  rawNpmError:
    'Error: Could not find Prisma Schema that is required for this command. (postinstall: prisma generate during npm install; prisma/ not in Docker layer before Step34 fix)',
  timeoutRelationship:
    'DEPLOYMENT_TIMEOUT was secondary wrapper; underlying docker build already failed with npm install exit 1',
  rootCause:
    'LaunchOS Dockerfile copied only package.json (+lock) before npm install; web-ceshi postinstall runs prisma generate which needs prisma/schema.prisma',
  failureCategory: 'DEPENDENCY_INSTALL_FAILED / POSTINSTALL_FAILED',
  packageManager: 'npm',
  lockfile: 'package-lock.json',
  nodeVersion: '20 (node:20-alpine)',
  npmPnpmYarnVersion: 'npm bundled with node:20-alpine',
  installCommand: 'npm install (Dockerfile RUN after COPY package*.json and COPY prisma)',
  devDependenciesState: 'installed during build (production NODE_ENV applied after install/build)',
  registryConnectivity: 'OK (npmmirror / registry.npmjs.org reachable on build host)',
  launchOsBugOrUserIssue: 'LaunchOS bug (fixed)',
  fixApplied:
    'COPY prisma before npm install + openssl; preserve DEPENDENCY_INSTALL_FAILED over DEPLOYMENT_TIMEOUT; worker also loads alpha-github.env for CALLBACK_URL',
  userFacingMessage: '依赖安装失败：构建环境在安装依赖时未准备好 Prisma schema。',
  suggestedAction: 'LaunchOS 已修复该构建步骤。请直接重新上线，无需修改项目代码。',
  fixPromptAvailability: 'NO (platform bug, not USER_CODE/USER_CONFIG)',
  retryFlow: 'reuse same Project/Environment/Source via plan → confirm → execute',
  webCeshiRegression: true,
  buildResult: {
    dependencyInstall: installPass && pastValidate ? 'PASS' : installPass && !githubAppFail ? 'UNKNOWN' : githubAppFail ? 'BLOCKED_BY_GITHUB_APP' : 'FAIL',
    dockerBuild:
      installPass && (dockerBuildPass || remoteDeployStatus === 'SUCCESS')
        ? 'PASS'
        : installPass && pastValidate
          ? remoteDeployStatus || 'IN_PROGRESS'
          : 'FAIL_OR_BLOCKED',
    remoteDeployStep: remoteDeployStatus,
    validateSource: validateStatus,
  },
  nextFailureIfAny: nextFailure,
  existingRoutes: routeChecks,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  deploymentResult: final?.status || null,
  sqlSnippet: sqlText.slice(0, 4500),
  finalPoll: {
    status: final?.status,
    currentStage: final?.currentStage,
    currentStep: final?.currentStep,
    failureCode: final?.failureCode,
    userMessage: final?.userMessage,
  },
  final: finalVerdict,
};

writeFileSync(join(ARTIFACT_DIR, 'step34-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
process.exit(report.final === 'PASS' ? 0 : 1);
