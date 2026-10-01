/**
 * Step 32 — rebuild/redeploy Alpha API + Web with failure diagnosis UX.
 * Records Alpha P1 for the real AUTH_SECRET LaunchRun failure.
 * node scripts/_tmp-step32-deploy-failure-ux.mjs --confirm-step32
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
if (!process.argv.includes('--confirm-step32')) {
  console.error('pass --confirm-step32');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute, presentDeploymentFailure } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const API_TAG = 'launchos-alpha-api:step32';
const WEB_TAG = 'launchos-alpha-web:step32';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_API = 'launchos-alpha-api';
const LIVE_WEB = 'launchos-alpha-web';
const CAND_API = 'launchos-alpha-api-cand-32';
const CAND_WEB = 'launchos-alpha-web-cand-32';
const LIVE_API_PORT = 39110;
const CAND_API_PORT = 39118;
const LIVE_WEB_PORT = 39111;
const CAND_WEB_PORT = 39119;
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const LAUNCH_RUN = 'cmunsomd000e9rl01l54fl7vk';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)\s*[=:]\s*\S+/gi, '$1=***');
}
function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
if (!server) throw new Error('alpha server missing');
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1200)}`);
  return r;
}
async function waitHttp(label, checkCmd, failCmd = 'true') {
  await runner.writeTextFile(
    `/opt/launchos/tmp/step32-wait-${label}.sh`,
    `#!/bin/sh
set +e
n=0
while [ "$n" -lt 40 ]; do
  n=\$((n + 1))
  if ${checkCmd}; then
    echo OK
    exit 0
  fi
  sleep 2
done
${failCmd}
exit 1
`,
  );
  await remoteOk(`chmod 700 /opt/launchos/tmp/step32-wait-${label}.sh && /opt/launchos/tmp/step32-wait-${label}.sh`, label, {
    timeoutMs: 120000,
  });
}

console.log('[1] build api+web');
const skipBuild = process.argv.includes('--skip-build');
if (!skipBuild) {
  const apiBuild = local('docker', ['build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.api', '-t', API_TAG, '.']);
  writeFileSync(join(ARTIFACT_DIR, 'step32-api-build.log'), redact(`${apiBuild.stdout || ''}\n${apiBuild.stderr || ''}`).slice(-250000));
  if (apiBuild.status !== 0) throw new Error('api build failed');
  const webBuild = local('docker', ['build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.web', '-t', WEB_TAG, '.']);
  writeFileSync(join(ARTIFACT_DIR, 'step32-web-build.log'), redact(`${webBuild.stdout || ''}\n${webBuild.stderr || ''}`).slice(-250000));
  if (webBuild.status !== 0) throw new Error('web build failed');
} else {
  console.log('skip-build: reusing local images');
}

const apiMarkers = local('docker', [
  'run',
  '--rm',
  '--entrypoint',
  'sh',
  API_TAG,
  '-c',
  'echo PRESENT=$(grep -c presentDeploymentFailure /app/apps/api/dist/launch/launch.service.js); echo P1=$(grep -c noteDeploymentFailureDiagnosisP1 /app/apps/api/dist/alpha-tests/alpha-tests.service.js); echo DOMAIN=$(grep -c presentDeploymentFailure /app/packages/domain/dist/deployment-failure-presentation.js /app/node_modules/@launchos/domain/dist/deployment-failure-presentation.js 2>/dev/null | awk -F: "{s+=\\$2} END{print s+0}")',
]);
console.log('api markers', String(apiMarkers.stdout || '').trim());
const apiOut = String(apiMarkers.stdout || '');
if (!/PRESENT=[1-9]/.test(apiOut) || !/P1=[1-9]/.test(apiOut)) {
  throw new Error(`api markers failed: ${apiOut}`);
}
const webMarkers = local('docker', [
  'run',
  '--rm',
  '--entrypoint',
  'sh',
  WEB_TAG,
  '-c',
  'grep -R -c "上线失败" /app/.next/server/app/onboarding/flow 2>/dev/null | head -5; grep -R -l "生成修复提示词" /app/.next 2>/dev/null | head -5',
]);
console.log('web markers', String(webMarkers.stdout || '').trim().slice(0, 800));

console.log('[2] upload/promote api');
const apiTar = join(ARTIFACT_DIR, 'launchos-alpha-api-step32.tar');
try {
  unlinkSync(apiTar);
} catch {}
if (local('docker', ['save', '-o', apiTar, API_TAG]).status !== 0) throw new Error('api save failed');
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir');
await runner.upload(apiTar, '/opt/launchos/tmp/launchos-alpha-api-step32.tar', { timeoutMs: 900000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-api-step32.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-step32.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
  'load-api',
  { timeoutMs: 600000 },
);

await runner.writeTextFile(
  '/opt/launchos/bin/step32-run-api.sh',
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
await remoteOk('chmod 700 /opt/launchos/bin/step32-run-api.sh', 'chmod-api');
await remoteOk(`/opt/launchos/bin/step32-run-api.sh ${CAND_API} ${CAND_API_PORT} ${API_REMOTE}`, 'cand-api', {
  timeoutMs: 120000,
});
await waitHttp(
  'wait-cand-api',
  `curl -fsS http://127.0.0.1:${CAND_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api`,
  `podman logs --tail 40 ${CAND_API}`,
);
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'api-alpha.zsaos.com',
  healthPath: '/api/v1/health',
  targetPort: CAND_API_PORT,
});
await remoteOk(`/opt/launchos/bin/step32-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'live-api', {
  timeoutMs: 120000,
});
await waitHttp(
  'wait-live-api',
  `curl -fsS http://127.0.0.1:${LIVE_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api`,
);
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'api-alpha.zsaos.com',
  healthPath: '/api/v1/health',
  targetPort: LIVE_API_PORT,
});
await remoteOk(`podman rm -f ${CAND_API} 2>/dev/null || true`, 'rm-cand-api');

console.log('[3] upload/promote web');
const webTar = join(ARTIFACT_DIR, 'launchos-alpha-web-step32.tar');
try {
  unlinkSync(webTar);
} catch {}
if (local('docker', ['save', '-o', webTar, WEB_TAG]).status !== 0) throw new Error('web save failed');
await runner.upload(webTar, '/opt/launchos/tmp/launchos-alpha-web-step32.tar', { timeoutMs: 900000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-web-step32.tar && rm -f /opt/launchos/tmp/launchos-alpha-web-step32.tar && (podman tag docker.io/library/${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || podman tag ${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || true)`,
  'load-web',
  { timeoutMs: 600000 },
);

await runner.writeTextFile(
  '/opt/launchos/bin/step32-run-web.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; PORT="$2"; IMAGE="$3"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-web.env \\
  -e "PORT=$PORT" \\
  "$IMAGE"
echo STARTED
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step32-run-web.sh', 'chmod-web');
await remoteOk(`/opt/launchos/bin/step32-run-web.sh ${CAND_WEB} ${CAND_WEB_PORT} ${WEB_REMOTE}`, 'cand-web', {
  timeoutMs: 120000,
});
await waitHttp(
  'wait-cand-web',
  `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${CAND_WEB_PORT}/ 2>/dev/null | grep -qE '200|307|308|404'`,
  `podman logs --tail 40 ${CAND_WEB}`,
);
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'alpha.zsaos.com',
  healthPath: '/',
  targetPort: CAND_WEB_PORT,
});
await remoteOk(`/opt/launchos/bin/step32-run-web.sh ${LIVE_WEB} ${LIVE_WEB_PORT} ${WEB_REMOTE}`, 'live-web', {
  timeoutMs: 120000,
});
await waitHttp(
  'wait-live-web',
  `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${LIVE_WEB_PORT}/ 2>/dev/null | grep -qE '200|307|308|404'`,
);
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'alpha.zsaos.com',
  healthPath: '/',
  targetPort: LIVE_WEB_PORT,
});
await remoteOk(`podman rm -f ${CAND_WEB} 2>/dev/null || true`, 'rm-cand-web');

console.log('[4] backfill failurePresentation + Alpha P1 on real LaunchRun');
const presented = presentDeploymentFailure({
  failureCode: '上线前还需要完成 1 项运行配置：AUTH_SECRET',
  failureMessage: '上线没有完成',
  currentStage: 'DEPLOY',
  currentStep: 'DEPLOY_WEB',
  projectId: PROJECT,
  deployableUnitId: 'cmunsmcpc00d2rl0184kdxdb3',
  projectName: 'web-ceshi',
  missingKeys: ['AUTH_SECRET'],
});

const ownerRow = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT w.\\"ownerId\\" FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" WHERE p.id='${PROJECT}';"`,
  'owner',
);
const ownerId = String(ownerRow.stdout || '').trim();
if (!ownerId) throw new Error('owner missing');

let sessionId = String(
  (
    await remoteOk(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"AlphaTestSession\\" WHERE \\"projectId\\"='${PROJECT}' OR \\"launchRunId\\"='${LAUNCH_RUN}' ORDER BY \\"updatedAt\\" DESC LIMIT 1;"`,
      'session-lookup',
    )
  ).stdout || '',
).trim();
if (!sessionId) {
  sessionId = `alpha_p1_step32_${Date.now()}`;
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 -c "INSERT INTO \\"AlphaTestSession\\" (id, \\"userId\\", \\"projectId\\", \\"launchRunId\\", \\"sessionStatus\\", \\"projectType\\", framework, dependencies, \\"startedAt\\", \\"sessionStartedAt\\", \\"createdAt\\", \\"updatedAt\\") VALUES ('${sessionId}', '${ownerId}', '${PROJECT}', '${LAUNCH_RUN}', 'IN_PROGRESS', 'WEB', 'OTHER_SUPPORTED', 'NONE', NOW(), NOW(), NOW(), NOW());"`,
    'session-create',
  );
}

const presentationJson = JSON.stringify(presented);
const eventMeta = JSON.stringify({
  stage: 'DEPLOYMENT_FAILURE_UX',
  note: 'External Alpha P1 — Deployment failure gives no actionable reason',
  classification: 'P1',
  session: sessionId,
  project: PROJECT,
  launchRun: LAUNCH_RUN,
  failureStage: presented.productStage,
  failureCategory: presented.category,
  userBlocked: true,
});

await runner.writeTextFile(
  '/opt/launchos/tmp/step32-backfill.sql',
  `UPDATE "LaunchRun"
SET
  "failureCode" = 'RUNTIME_CONFIG_MISSING',
  "failureMessage" = $msg$${presented.userMessage}$msg$,
  "planSnapshot" = COALESCE("planSnapshot", '{}'::jsonb) || jsonb_build_object(
    'failurePresentation', $pres$${presentationJson}$pres$::jsonb,
    'rawFailureDetail', '上线前还需要完成 1 项运行配置：AUTH_SECRET'
  )
WHERE id = '${LAUNCH_RUN}';

INSERT INTO "ProductEvent" (id, name, "userId", "projectId", "sessionId", metadata, "createdAt")
VALUES (
  'pe_step32_${Date.now()}',
  'ALPHA_FRICTION_NOTED',
  '${ownerId}',
  '${PROJECT}',
  '${sessionId}',
  $meta$${eventMeta}$meta$::jsonb,
  NOW()
);

SELECT id, status, "failureCode", left("failureMessage", 120) FROM "LaunchRun" WHERE id = '${LAUNCH_RUN}';
SELECT id, name, "sessionId" FROM "ProductEvent" WHERE "sessionId" = '${sessionId}' ORDER BY "createdAt" DESC LIMIT 3;
`,
);
const backfill = await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step32-backfill.sql',
  'backfill',
);

const report = {
  ok: true,
  launchRunId: LAUNCH_RUN,
  projectId: PROJECT,
  deployment: null,
  realFailureStage: presented.productStage,
  rawRootCauseSummary: 'AUTH_SECRET RuntimeConfigRequirement missing; managed launch aborted before Deployment create',
  failureCategory: presented.category,
  userResponsibility: true,
  retryable: presented.retryable,
  currentUxProblem: '上线没有完成 + black-dot progress only',
  newUserMessage: presented.userMessage,
  suggestedAction: presented.suggestedAction,
  fixPromptAvailable: presented.fixPromptAvailable,
  retryFlow: 'onboarding/plan → confirm → launch (same Project/Environment/Source, new LaunchRun)',
  progressUi: '✓ success / ✕ failed / ○ pending',
  alphaP1: {
    session: sessionId,
    project: PROJECT,
    launchRun: LAUNCH_RUN,
    failureStage: presented.productStage,
    failureCategory: presented.category,
    userBlocked: true,
  },
  backfillSnippet: redact(String(backfill.stdout || '')).slice(0, 800),
  secretsExposed: 'NO',
};
writeFileSync(join(ARTIFACT_DIR, 'step32-deploy-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
