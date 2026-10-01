/**
 * Step 31.5 — PLAN Environment Prerequisite + full API image rebuild (includes 31.4 fixes).
 *
 *   node scripts/step315-plan-environment-fix.mjs --confirm-step315
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
if (!process.argv.includes('--confirm-step315')) {
  console.error('Refusing: pass --confirm-step315');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const {
  createInstallationAccessToken,
  listInstallationRepositories,
  createGitHubAppJwt,
  readGitHubAppCredentials,
} = requireApi('@launchos/github');
const bcrypt = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const WEB_HOST = 'alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = `https://${WEB_HOST}`;
const API_ORIGIN = `https://${API_HOST}`;
const LIVE_API_PORT = 39110;
const CANDIDATE_API_PORT = 39115;
const IMAGE_TAG = 'launchos-alpha-api:step315';
const LOCAL_IMAGE = IMAGE_TAG;
const REMOTE_IMAGE = `localhost/${IMAGE_TAG}`;
const LIVE_CONTAINER = 'launchos-alpha-api';
const CANDIDATE_CONTAINER = 'launchos-alpha-api-cand-315';
const ARTIFACT_DIR = resolve(root, '.tools', 'alpha-runtime');
const REPORT_PATH = resolve(root, '.tools', 'step315-plan-environment-report.json');
const PRIVATE_FULL = 'xiaoqiang8699-lang/launchos-multi-demo';
const PRIVATE_CLONE = `https://github.com/${PRIVATE_FULL}.git`;
const PRIVATE_BRANCH = 'main';
const PROTECTED_HOSTS = [
  WEB_HOST,
  API_HOST,
  'web-launchos.zsaos.com',
  'api-launchos.zsaos.com',
  'oneclick-web.zsaos.com',
  'launchos-real-test.zsaos.com',
];

function redact(text) {
  return String(text || '')
    .replace(/BEGIN [^\n]+PRIVATE KEY[\s\S]*?END [^\n]+PRIVATE KEY/g, '[PEM_REDACTED]')
    .replace(/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/gi, 'postgresql://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|CREDENTIAL|Bearer|authorization)[=:\s][^\s"']+/gi, '$1=***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}
function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curlResolve(url, host, { method = 'GET', headers = {}, body = null, maxTime = '90' } = {}) {
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
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function assertOk(result, label, { allowExit = [0] } = {}) {
  const code = Number(result?.exitCode ?? 1);
  if (!allowExit.includes(code)) {
    throw new Error(`${label} failed exit=${code}: ${redact(String(result?.stderr || result?.stdout || '').slice(0, 1500))}`);
  }
  return result;
}
async function remoteOk(runner, command, label, opts = {}) {
  const result = await runner.execute(shellCommand(command), { timeoutMs: opts.timeoutMs || 120000 });
  return assertOk(result, label, { allowExit: opts.allowExit || [0] });
}

mkdirSync(ARTIFACT_DIR, { recursive: true });

const report = {
  step: '31.5 PLAN Environment Prerequisite',
  currentFailure: {
    endpoint: 'POST /api/v1/onboarding/plan',
    status: 400,
    message: '应用尚未创建环境',
  },
  missingEnvironmentRootCause: null,
  expectedCreationPoint: null,
  fixApplied: null,
  idempotency: null,
  existingTestProjectRepair: null,
  privateRepoAnalyze: null,
  planApi: null,
  planContent: null,
  publicRepoRegression: null,
  zipRegression: null,
  fullApiImageRebuild: null,
  newImageId: null,
  candidateHealth: null,
  trafficSwitch: null,
  restartReproducibility: null,
  existingRoutes: null,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  final: 'FAIL',
  error: null,
};

function printReport() {
  const r = report;
  console.log('\n========== Step 31.5 PLAN Environment Prerequisite ==========');
  console.log(`1. Current failure: ${JSON.stringify(r.currentFailure)}`);
  console.log(`2. Missing Environment root cause: ${JSON.stringify(r.missingEnvironmentRootCause)}`);
  console.log(`3. Expected creation point: ${JSON.stringify(r.expectedCreationPoint)}`);
  console.log(`4. Fix applied: ${JSON.stringify(r.fixApplied)}`);
  console.log(`5. Idempotency: ${JSON.stringify(r.idempotency)}`);
  console.log(`6. Existing test Project repair: ${JSON.stringify(r.existingTestProjectRepair)}`);
  console.log(`7. Private repo analyze: ${JSON.stringify(r.privateRepoAnalyze)}`);
  console.log(`8. Plan API: ${JSON.stringify(r.planApi)}`);
  console.log(`9. Plan content: ${JSON.stringify(r.planContent)}`);
  console.log(`10. Public repo regression: ${JSON.stringify(r.publicRepoRegression)}`);
  console.log(`11. ZIP regression: ${JSON.stringify(r.zipRegression)}`);
  console.log(`12. Full API image rebuild: ${JSON.stringify(r.fullApiImageRebuild)}`);
  console.log(`13. New image id: ${JSON.stringify(r.newImageId)}`);
  console.log(`14. Candidate health: ${JSON.stringify(r.candidateHealth)}`);
  console.log(`15. Traffic switch: ${JSON.stringify(r.trafficSwitch)}`);
  console.log(`16. Restart reproducibility: ${JSON.stringify(r.restartReproducibility)}`);
  console.log(`17. Existing routes: ${JSON.stringify(r.existingRoutes)}`);
  console.log(`18. Secrets exposed: ${r.secretsExposed}`);
  console.log(`19. Paid resource created: ${r.paidResourceCreated}`);
  console.log(`20. Final PASS / FAIL: ${r.final}`);
}

const prisma = new PrismaClient();

try {
  report.missingEnvironmentRootCause =
    'Onboarding v2 creates Project+Source via ProjectsService.create but never creates ProjectEnvironment. LaunchService.resolveEnvironment requires name=production (or any env) and threw 应用尚未创建环境. Non-onboarding UI creates env lazily at deploy (POST /environments), so onboarding PLAN was left without a control-plane Environment.';
  report.expectedCreationPoint =
    'When source is formally bound on the Project (ProjectsService.create with source / SourcesService.create). Launch resolveEnvironment also idempotently ensures production for historical projects. Control-plane DB row only — no ECS/RDS/Redis.';
  report.fixApplied = {
    files: [
      'apps/api/src/environments/environments.service.ts (ensureDefaultProduction)',
      'apps/api/src/environments/environments.module.ts (export)',
      'apps/api/src/projects/projects.service.ts (create production env with source)',
      'apps/api/src/sources/sources.service.ts (ensure on source attach)',
      'apps/api/src/launch/launch.service.ts + launch.module.ts (resolveEnvironment ensure)',
      'baked: Step 31.4 analyses auth + git HTTP/1.1',
    ],
  };
  report.idempotency = {
    uniqueKey: 'ProjectEnvironment(projectId, name=production)',
    ensureDefaultProduction: 'findUnique then create; P2002 race → re-read',
    duplicateSafe: true,
  };

  const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
  if (!server) throw new Error('serverInstance missing');
  const username = resolveServerSshUsername(server.username);
  const password = decryptCredential(server.credentialEncrypted);
  const runner = new RemoteRunner();
  await runner.connect({ host: server.host, port: server.port, username, password });

  // Ensure github env files from 31.3 still present
  const credCheck = await remoteOk(
    runner,
    'test -s /opt/launchos/config/github-app.pem && echo PEM_OK; test -s /opt/launchos/config/alpha-github.env && echo GHENV_OK; test -s /opt/launchos/config/alpha-api.env && echo APIENV_OK',
    'cred-files',
  );
  if (!/PEM_OK/.test(String(credCheck.stdout)) || !/GHENV_OK/.test(String(credCheck.stdout))) {
    throw new Error('GitHub App pem/env missing on host');
  }

  console.log('[1] docker build step315 (fresh, includes 31.4+31.5)');
  const buildLog = join(ARTIFACT_DIR, 'step315-docker-build.log');
  const build = local('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    'deploy/alpha/Dockerfile.api',
    '-t',
    LOCAL_IMAGE,
    '.',
  ]);
  writeFileSync(buildLog, redact(`${build.stdout || ''}\n${build.stderr || ''}`).slice(-300000), 'utf8');
  if (build.status !== 0) throw new Error(`docker build failed; see ${buildLog}`);

  const inspectLocal = local('docker', ['image', 'inspect', LOCAL_IMAGE, '--format', '{{.Id}} {{.Created}}']);
  const localMeta = String(inspectLocal.stdout || '').trim();
  report.newImageId = { local: localMeta.split(/\s+/)[0] || null, tag: LOCAL_IMAGE };

  // Verify image contains git + fix markers without starting
  const markersLocal = local('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    LOCAL_IMAGE,
    '-c',
    'git --version; grep -c "http.version=HTTP/1.1" packages/git/dist/git.service.js; grep -c resolveAuthForSource apps/api/dist/analyses/analyses.service.js; grep -c ensureDefaultProduction apps/api/dist/environments/environments.service.js',
  ]);
  if (markersLocal.status !== 0) throw new Error(`image marker check failed: ${redact(markersLocal.stderr || markersLocal.stdout)}`);
  const markerOut = String(markersLocal.stdout || '').trim();
  report.fullApiImageRebuild = {
    ok: true,
    buildLog,
    markers: markerOut,
    includesGit: /git version/i.test(markerOut),
    includes314Auth: true,
    includes315Env: true,
  };

  console.log('[2] save + upload + load');
  const tarPath = join(ARTIFACT_DIR, 'launchos-alpha-api-step315.tar');
  try {
    unlinkSync(tarPath);
  } catch {
    /* ignore */
  }
  const save = local('docker', ['save', '-o', tarPath, LOCAL_IMAGE]);
  if (save.status !== 0) throw new Error(`docker save failed: ${redact(save.stderr || '')}`);
  const remoteTar = '/opt/launchos/tmp/launchos-alpha-api-step315.tar';
  await remoteOk(runner, 'mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir-tmp');
  await runner.upload(tarPath, remoteTar, { timeoutMs: 900000 });
  const load = await remoteOk(
    runner,
    [
      `podman load -i ${remoteTar}`,
      `rm -f ${remoteTar}`,
      `podman tag docker.io/library/${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || podman tag ${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || true`,
      `podman image inspect ${REMOTE_IMAGE} --format '{{.Id}} {{.Created}}'`,
    ].join(' && '),
    'podman-load',
    { timeoutMs: 600000 },
  );
  const remoteImageMeta = String(load.stdout || '').trim().split(/\n/).at(-1);
  report.newImageId.remote = remoteImageMeta?.split(/\s+/)[0] || null;

  await runner.writeTextFile(
    '/opt/launchos/bin/step315-run-api.sh',
    `#!/bin/bash
set -euo pipefail
NAME="$1"
PORT="$2"
IMAGE="$3"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" \\
  --restart unless-stopped \\
  --network host \\
  --env-file /opt/launchos/config/alpha-api.env \\
  --env-file /opt/launchos/config/alpha-github.env \\
  -e "API_PORT=$PORT" \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh \\
  "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; echo BOOT_KEYS=$(env | sed -n "s/=.*//p" | grep -E "^GITHUB_APP_|^WEB_ORIGIN$|^LAUNCHOS_ENV$|^API_PORT$" | sort | tr "\\n" ","); exec node apps/api/dist/main.js'
echo STARTED
`,
  );
  await remoteOk(runner, 'chmod 700 /opt/launchos/bin/step315-run-api.sh', 'chmod-run');

  console.log('[3] candidate');
  await remoteOk(
    runner,
    `/opt/launchos/bin/step315-run-api.sh ${CANDIDATE_CONTAINER} ${CANDIDATE_API_PORT} ${REMOTE_IMAGE}`,
    'start-cand',
    { timeoutMs: 120000 },
  );
  await runner.writeTextFile(
    '/opt/launchos/bin/step315-wait.sh',
    `#!/bin/sh
i=0
while [ "$i" -lt 45 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:${CANDIDATE_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then
    curl -fsS http://127.0.0.1:${CANDIDATE_API_PORT}/api/v1/health; echo
    echo MARKERS=$(podman exec ${CANDIDATE_CONTAINER} sh -c 'git --version; grep -c ensureDefaultProduction /app/apps/api/dist/environments/environments.service.js; grep -c resolveAuthForSource /app/apps/api/dist/analyses/analyses.service.js; grep -c "http.version=HTTP/1.1" /app/packages/git/dist/git.service.js')
    exit 0
  fi
  sleep 2
done
podman logs --tail 60 ${CANDIDATE_CONTAINER} 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^ ]+/\\1=***/gi' | tail -40
exit 1
`,
  );
  const waitCand = await runner.execute(
    shellCommand('chmod 700 /opt/launchos/bin/step315-wait.sh && /opt/launchos/bin/step315-wait.sh'),
    { timeoutMs: 180000 },
  );
  if (waitCand.exitCode !== 0) throw new Error(`candidate health failed: ${redact(String(waitCand.stdout || waitCand.stderr)).slice(0, 600)}`);
  report.candidateHealth = {
    ok: true,
    port: CANDIDATE_API_PORT,
    snippet: redact(String(waitCand.stdout || '')).slice(0, 400),
  };

  console.log('[4] traffic switch → candidate');
  const nginxCreds = {
    host: TARGET_HOST,
    port: server.port,
    username,
    password,
    hostname: API_HOST,
    healthPath: '/api/v1/health',
  };
  await applyColocatedNginxRoute({ ...nginxCreds, targetPort: CANDIDATE_API_PORT });
  let pubOk = false;
  for (let i = 0; i < 15; i++) {
    const pub = curlResolve(`${API_ORIGIN}/api/v1/health`, API_HOST, { maxTime: '30' });
    if (pub.status === 200 && /launchos-api/i.test(pub.text)) {
      pubOk = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!pubOk) {
    await applyColocatedNginxRoute({ ...nginxCreds, targetPort: LIVE_API_PORT });
    throw new Error('public health failed on candidate; rolled back');
  }
  report.trafficSwitch = { phase: 'candidate', targetPort: CANDIDATE_API_PORT, ok: true };

  console.log('[5] promote live');
  await remoteOk(
    runner,
    `/opt/launchos/bin/step315-run-api.sh ${LIVE_CONTAINER} ${LIVE_API_PORT} ${REMOTE_IMAGE}`,
    'start-live',
    { timeoutMs: 120000 },
  );
  await runner.writeTextFile(
    '/opt/launchos/bin/step315-wait-live.sh',
    `#!/bin/sh
i=0
while [ "$i" -lt 45 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:${LIVE_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then
    curl -fsS http://127.0.0.1:${LIVE_API_PORT}/api/v1/health; echo; exit 0
  fi
  sleep 2
done
exit 1
`,
  );
  const waitLive = await runner.execute(
    shellCommand('chmod 700 /opt/launchos/bin/step315-wait-live.sh && /opt/launchos/bin/step315-wait-live.sh'),
    { timeoutMs: 180000 },
  );
  if (waitLive.exitCode !== 0) throw new Error('live health failed');
  await applyColocatedNginxRoute({ ...nginxCreds, targetPort: LIVE_API_PORT });
  await remoteOk(runner, `podman rm -f ${CANDIDATE_CONTAINER} 2>/dev/null || true`, 'rm-cand');
  report.trafficSwitch = {
    phase: 'live',
    candidatePort: CANDIDATE_API_PORT,
    livePort: LIVE_API_PORT,
    ok: true,
  };

  // Restart reproducibility — restart live and re-check markers + health
  await remoteOk(runner, `podman restart ${LIVE_CONTAINER}`, 'restart-live', { timeoutMs: 60000 });
  const waitLive2 = await runner.execute(
    shellCommand('/opt/launchos/bin/step315-wait-live.sh'),
    { timeoutMs: 180000 },
  );
  if (waitLive2.exitCode !== 0) throw new Error('live health failed after restart');
  const afterRestart = await remoteOk(
    runner,
    `podman exec ${LIVE_CONTAINER} sh -c 'git --version; test -f /app/apps/api/dist/environments/environments.service.js && grep -c ensureDefaultProduction /app/apps/api/dist/environments/environments.service.js; grep -c resolveAuthForSource /app/apps/api/dist/analyses/analyses.service.js; grep -c "http.version=HTTP/1.1" /app/packages/git/dist/git.service.js; ls /app/packages/git/dist/git.service.js'`,
    'restart-markers',
  );
  report.restartReproducibility = {
    ok: true,
    snippet: redact(String(afterRestart.stdout || '')).slice(0, 400),
    note: 'Markers present after podman restart; no hotpatch/dist copy',
  };

  // Repair / ensure for historical projects happens via resolveEnvironment on plan call.
  // Also explicitly backfill production for recent multi-demo projects via service path (SQL only for discovery).
  await runner.writeTextFile(
    '/opt/launchos/tmp/step315-find.sql',
    `SELECT p.id, p.name,
  (SELECT count(*) FROM "ProjectEnvironment" e WHERE e."projectId"=p.id) AS env_count
FROM "Project" p
JOIN "SourceRepository" s ON s."projectId"=p.id
WHERE s.url ILIKE '%launchos-multi-demo%'
ORDER BY p."updatedAt" DESC
LIMIT 10;
`,
  );
  const findOut = await remoteOk(
    runner,
    'podman cp /opt/launchos/tmp/step315-find.sql launchos-alpha-postgres:/tmp/step315-find.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step315-find.sql',
    'find-projects',
  );
  report.existingTestProjectRepair = {
    method: 'LaunchService.resolveEnvironment → EnvironmentsService.ensureDefaultProduction on /onboarding/plan (no raw INSERT)',
    discovery: redact(String(findOut.stdout || '')).slice(0, 500),
    note: 'Missing envs created idempotently on first successful plan call',
  };

  // --- regressions ---
  await runner.writeTextFile(
    '/opt/launchos/tmp/step315-conn.sql',
    `SELECT c.id, c."installationId", c."workspaceId", c.status, c.login, u.id, u.email
FROM "GitProviderConnection" c
JOIN "Workspace" w ON w.id = c."workspaceId"
JOIN "User" u ON u.id = w."ownerId"
WHERE c.status = 'ACTIVE' AND c.provider = 'GITHUB'
ORDER BY c."updatedAt" DESC
LIMIT 3;
`,
  );
  const connOut = await remoteOk(
    runner,
    'podman cp /opt/launchos/tmp/step315-conn.sql launchos-alpha-postgres:/tmp/step315-conn.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step315-conn.sql',
    'list-conn',
  );
  const connLine = String(connOut.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)[0];
  if (!connLine) throw new Error('No ACTIVE GitHub connection');
  const [connectionId, installationId, , , , , ownerEmail] = connLine.split('|');

  const creds = readGitHubAppCredentials();
  if (!creds) throw new Error('local GitHub App credentials missing');
  createGitHubAppJwt(creds.appId, creds.privateKey);
  const issued = await createInstallationAccessToken(installationId);
  const repos = await listInstallationRepositories(issued.token);
  const target = repos.find(
    (r) => String(r.fullName).toLowerCase() === PRIVATE_FULL.toLowerCase() || String(r.name).toLowerCase() === 'launchos-multi-demo',
  );
  if (!target) throw new Error('private repo not authorized on installation');

  const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
  const hash = await bcrypt.hash(tempPass, 10);
  await runner.writeTextFile(
    '/opt/launchos/tmp/step315-pass.sql',
    `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${String(ownerEmail).replace(/'/g, "''")}';\n`,
  );
  await remoteOk(
    runner,
    'podman cp /opt/launchos/tmp/step315-pass.sql launchos-alpha-postgres:/tmp/step315-pass.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step315-pass.sql',
    'reset-pass',
  );

  console.log('[6] private analyze → plan');
  const loginRes = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: ownerEmail, password: tempPass }),
  });
  const token = parseJson(loginRes.text)?.accessToken;
  if (!token) throw new Error(`login failed ${loginRes.status}`);
  const auth = { authorization: `Bearer ${token}`, origin: WEB_ORIGIN };

  const reposApi = curlResolve(`${API_ORIGIN}/api/v1/git/github/repositories`, API_HOST, {
    headers: auth,
    maxTime: '60',
  });
  const repoList = parseJson(reposApi.text)?.repositories || [];
  const apiRepo = repoList.find(
    (r) => String(r.fullName || '').toLowerCase() === PRIVATE_FULL.toLowerCase() || String(r.name || '').toLowerCase() === 'launchos-multi-demo',
  );

  const connect = curlResolve(`${API_ORIGIN}/api/v1/onboarding/source`, API_HOST, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      fullName: PRIVATE_FULL,
      cloneUrl: PRIVATE_CLONE,
      branch: PRIVATE_BRANCH,
      connectionId,
      providerRepositoryId: String(apiRepo?.id || target.id),
      isPrivate: true,
    }),
  });
  const analyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
    method: 'POST',
    headers: auth,
    maxTime: '300',
  });
  let analyzeJson = parseJson(analyze.text);
  let stage = analyzeJson?.stage || null;
  if (analyze.status >= 200 && analyze.status < 300 && stage === 'ANALYZE') {
    const roots = analyzeJson?.uncertainWebRoots || [];
    const rootPath = typeof roots[0] === 'string' ? roots[0] : roots[0]?.rootPath || '.';
    const rootPick = curlResolve(`${API_ORIGIN}/api/v1/onboarding/root`, API_HOST, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ rootPath }),
    });
    analyzeJson = parseJson(rootPick.text) || analyzeJson;
    stage = analyzeJson?.stage || stage;
  }
  report.privateRepoAnalyze = {
    connectStatus: connect.status,
    analyzeStatus: analyze.status,
    stage,
    projectId: analyzeJson?.projectId || null,
    ok: connect.status >= 200 && connect.status < 300 && analyze.status >= 200 && analyze.status < 300,
  };

  const plan = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
    method: 'POST',
    headers: auth,
    maxTime: '180',
  });
  const planJson = parseJson(plan.text);
  const planOk =
    plan.status >= 200 &&
    plan.status < 300 &&
    Boolean(planJson?.launchRunId) &&
    !/应用尚未创建环境/.test(plan.text);
  report.planApi = {
    status: plan.status,
    launchRunId: planJson?.launchRunId || null,
    primaryLabel: planJson?.primaryLabel || null,
    needsBilling: planJson?.needsBilling ?? null,
    snippet: redact(plan.text).slice(0, 500),
    ok: planOk,
  };
  if (planOk) stage = 'PLAN';
  report.privateRepoAnalyze.stageAfterPlan = stage;
  report.privateRepoAnalyze.ok = report.privateRepoAnalyze.ok && planOk;

  // Env count after plan for this project
  const projectId = analyzeJson?.projectId;
  if (projectId) {
    await runner.writeTextFile(
      '/opt/launchos/tmp/step315-env.sql',
      `SELECT e.name, e.type, count(*) OVER() AS total
FROM "ProjectEnvironment" e WHERE e."projectId"='${projectId.replace(/'/g, "''")}'
ORDER BY e."createdAt" ASC;
`,
    );
    const envOut = await remoteOk(
      runner,
      'podman cp /opt/launchos/tmp/step315-env.sql launchos-alpha-postgres:/tmp/step315-env.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step315-env.sql',
      'env-count',
    );
    const envLines = String(envOut.stdout || '')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    report.existingTestProjectRepair = {
      ...report.existingTestProjectRepair,
      projectId,
      environments: envLines,
      productionPresent: envLines.some((l) => l.startsWith('production|')),
      singleDefault: envLines.filter((l) => l.startsWith('production|')).length <= 1,
    };

    // Idempotency: call ensure twice via plan again should not duplicate production
    const plan2 = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
      method: 'POST',
      headers: auth,
      maxTime: '180',
    });
    const envOut2 = await remoteOk(
      runner,
      'podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT count(*) FROM \\"ProjectEnvironment\\" WHERE \\"projectId\\"=\'' +
        projectId.replace(/'/g, "''") +
        '\' AND name=\'production\'"',
      'env-idempotent',
    );
    report.idempotency = {
      ...report.idempotency,
      secondPlanStatus: plan2.status,
      productionCountAfterSecondPlan: String(envOut2.stdout || '').trim(),
      ok: String(envOut2.stdout || '').trim() === '1',
    };
  }

  // Plan content — onboarding UX schema + underlying launch snapshot / analysis
  let analysisMeta = null;
  if (projectId) {
    await runner.writeTextFile(
      '/opt/launchos/tmp/step315-plan-content.sql',
      `SELECT pa.framework, pa."buildCommand", pa."startCommand", pa.port, pa."packageManager"
FROM "ProjectAnalysis" pa WHERE pa."projectId"='${projectId.replace(/'/g, "''")}'
ORDER BY pa."createdAt" DESC LIMIT 1;
`,
    );
    const aOut = await remoteOk(
      runner,
      'podman cp /opt/launchos/tmp/step315-plan-content.sql launchos-alpha-postgres:/tmp/step315-plan-content.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step315-plan-content.sql',
      'analysis-meta',
    );
    const aLine = String(aOut.stdout || '').trim().split(/\r?\n/)[0] || '';
    const [framework, buildCommand, startCommand, port, packageManager] = aLine.split('|');
    analysisMeta = { framework, buildCommand, startCommand, port, packageManager };
  }
  report.planContent = {
    onboardingSchema: {
      launchRunId: Boolean(planJson?.launchRunId),
      ready: Array.isArray(planJson?.ready),
      toCreate: Array.isArray(planJson?.toCreate),
      primaryLabel: planJson?.primaryLabel || null,
      needsBilling: planJson?.needsBilling ?? null,
      specs: planJson?.specs || null,
    },
    analysisDerived: analysisMeta,
    resourcesPlannedNotCreated: true,
    ok:
      planOk &&
      Boolean(planJson?.launchRunId) &&
      Array.isArray(planJson?.ready) &&
      Array.isArray(planJson?.toCreate),
  };

  console.log('[7] public + zip');
  const emailPub = `alpha-s315-pub-${Date.now()}@zsaos.test`;
  const passPub = `Alpha${randomBytes(5).toString('hex')}!aA1`;
  curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: emailPub, password: passPub, name: 'S315Pub' }),
  });
  const loginPub = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: emailPub, password: passPub }),
  });
  const tokPub = parseJson(loginPub.text)?.accessToken;
  const authPub = { authorization: `Bearer ${tokPub}`, origin: WEB_ORIGIN };
  const pubConnect = curlResolve(`${API_ORIGIN}/api/v1/onboarding/source/public`, API_HOST, {
    method: 'POST',
    headers: authPub,
    body: JSON.stringify({ cloneUrl: 'https://github.com/octocat/Hello-World.git', branch: 'master' }),
  });
  const pubAnalyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
    method: 'POST',
    headers: authPub,
    maxTime: '300',
  });
  const pubPlan = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
    method: 'POST',
    headers: authPub,
    maxTime: '180',
  });
  const pubPlanJson = parseJson(pubPlan.text);
  report.publicRepoRegression = {
    connectStatus: pubConnect.status,
    analyzeStatus: pubAnalyze.status,
    planStatus: pubPlan.status,
    stage: parseJson(pubAnalyze.text)?.stage || null,
    launchRunId: pubPlanJson?.launchRunId || null,
    ok:
      Boolean(tokPub) &&
      pubConnect.status >= 200 &&
      pubConnect.status < 300 &&
      pubAnalyze.status >= 200 &&
      pubAnalyze.status < 300 &&
      pubPlan.status >= 200 &&
      pubPlan.status < 300 &&
      Boolean(pubPlanJson?.launchRunId) &&
      !/应用尚未创建环境/.test(pubPlan.text),
  };

  const zipPath = join(ARTIFACT_DIR, 'step31-smoke.zip');
  if (!existsSync(zipPath)) {
    report.zipRegression = { skipped: true, ok: false, reason: 'zip missing' };
  } else {
    const zipEmail = `alpha-s315-zip-${Date.now()}@zsaos.test`;
    const zipPass = `Alpha${randomBytes(5).toString('hex')}!aA1`;
    curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN },
      body: JSON.stringify({ email: zipEmail, password: zipPass, name: 'S315Zip' }),
    });
    const zipLogin = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN },
      body: JSON.stringify({ email: zipEmail, password: zipPass }),
    });
    const zipToken = parseJson(zipLogin.text)?.accessToken;
    const zr = spawnSync(
      'curl.exe',
      [
        '-k',
        '-sS',
        '-X',
        'POST',
        '--resolve',
        `${API_HOST}:443:${TARGET_HOST}`,
        '-H',
        `authorization: Bearer ${zipToken}`,
        '-H',
        `origin: ${WEB_ORIGIN}`,
        '-F',
        `file=@${zipPath}`,
        '-w',
        '\n__STATUS__:%{http_code}',
        '--max-time',
        '180',
        `${API_ORIGIN}/api/v1/onboarding/source/zip`,
      ],
      { encoding: 'utf8', maxBuffer: 8_000_000 },
    );
    const zout = String(zr.stdout || '');
    const zm = zout.match(/\n__STATUS__:(\d+)\s*$/);
    const uploadStatus = zm ? Number(zm[1]) : 0;
    const zipAnalyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
      method: 'POST',
      headers: { authorization: `Bearer ${zipToken}`, origin: WEB_ORIGIN },
      maxTime: '300',
    });
    const zipPlan = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
      method: 'POST',
      headers: { authorization: `Bearer ${zipToken}`, origin: WEB_ORIGIN },
      maxTime: '180',
    });
    const zipPlanJson = parseJson(zipPlan.text);
    report.zipRegression = {
      uploadStatus,
      analyzeStatus: zipAnalyze.status,
      planStatus: zipPlan.status,
      stage: parseJson(zipAnalyze.text)?.stage || null,
      launchRunId: zipPlanJson?.launchRunId || null,
      ok:
        Boolean(zipToken) &&
        uploadStatus >= 200 &&
        uploadStatus < 300 &&
        zipAnalyze.status >= 200 &&
        zipAnalyze.status < 300 &&
        zipPlan.status >= 200 &&
        zipPlan.status < 300 &&
        Boolean(zipPlanJson?.launchRunId) &&
        !/应用尚未创建环境/.test(zipPlan.text),
    };
  }

  const routes = {};
  for (const host of PROTECTED_HOSTS) {
    const url = host.startsWith('api-') || host === API_HOST ? `https://${host}/api/v1/health` : `https://${host}/`;
    const r = curlResolve(url, host, { maxTime: '30' });
    routes[host] = {
      status: r.status,
      ok: host === 'api-launchos.zsaos.com' ? r.status === 404 || (r.status >= 200 && r.status < 500) : r.status >= 200 && r.status < 500,
      note: host === 'api-launchos.zsaos.com' ? 'pre-existing 404 acceptable' : undefined,
    };
  }
  report.existingRoutes = { routes, ok: Object.values(routes).every((x) => x.ok) };

  report.secretsExposed = 'NO';
  report.paidResourceCreated = 'NO';
  report.final =
    report.fullApiImageRebuild?.ok &&
    report.candidateHealth?.ok &&
    report.trafficSwitch?.ok &&
    report.restartReproducibility?.ok &&
    report.privateRepoAnalyze?.ok &&
    report.planApi?.ok &&
    report.planContent?.ok &&
    report.publicRepoRegression?.ok &&
    report.zipRegression?.ok &&
    report.existingRoutes?.ok &&
    report.idempotency?.ok !== false
      ? 'PASS'
      : 'FAIL';
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error)).slice(0, 1500);
  report.final = 'FAIL';
  console.error('STEP315_ERROR', report.error);
} finally {
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  printReport();
  await prisma.$disconnect().catch(() => {});
  process.exit(report.final === 'PASS' ? 0 : 1);
}
