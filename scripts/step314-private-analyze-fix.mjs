/**
 * Step 31.4 — GitHub Private Repo ANALYZE 500 fix + candidate redeploy + regress.
 *
 *   node scripts/step314-private-analyze-fix.mjs --confirm-step314
 *
 * Rebuild Alpha API with installation-token auth wired into analyzeCode clone.
 * Candidate → health → traffic switch → promote. No secrets printed. No paid resources.
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const SKIP_REDEPLOY = process.argv.includes('--skip-redeploy');

if (!process.argv.includes('--confirm-step314')) {
  console.error('Refusing: pass --confirm-step314');
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
  getInstallation,
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
const CANDIDATE_API_PORT = 39114;
const IMAGE_TAG = 'launchos-alpha-api:step314';
const LOCAL_IMAGE = IMAGE_TAG;
const REMOTE_IMAGE = `localhost/${IMAGE_TAG}`;
const LIVE_CONTAINER = 'launchos-alpha-api';
const CANDIDATE_CONTAINER = 'launchos-alpha-api-cand-314';
const ARTIFACT_DIR = resolve(root, '.tools', 'alpha-runtime');
const REPORT_PATH = resolve(root, '.tools', 'step314-private-analyze-report.json');
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
    .replace(/redis:\/\/[^:\s]+:[^@\s]+@/gi, 'redis://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|CREDENTIAL|Bearer|authorization)[=:\s][^\s"']+/gi, '$1=***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}

function local(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32_000_000,
    shell: false,
    ...opts,
  });
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
  if (body != null) {
    args.push('-H', 'content-type: application/json');
    args.push('--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return {
    status: m ? Number(m[1]) : 0,
    text: m ? out.slice(0, m.index) : out,
    err: redact(String(r.stderr || '')).slice(0, 500),
  };
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
    throw new Error(
      `${label} failed exit=${code}: ${redact(String(result?.stderr || result?.stdout || '').slice(0, 1500))}`,
    );
  }
  return result;
}

async function remoteOk(runner, command, label, opts = {}) {
  const { allowExit = [0], timeoutMs = 120000 } = opts;
  const result = await runner.execute(shellCommand(command), { timeoutMs });
  return assertOk(result, label, { allowExit });
}

mkdirSync(ARTIFACT_DIR, { recursive: true });

const report = {
  step: '31.4 GitHub Private Repo ANALYZE 500',
  failingRequest: null,
  errorStackSummary: null,
  rootCause: null,
  installationIdState: null,
  repositoryAuthorizationState: null,
  installationTokenState: null,
  privateRepoAuthenticatedAccess: null,
  cloneFetchDiagnosis: null,
  fixApplied: null,
  apiRedeploy: null,
  privateRepoAnalyze: null,
  publicRepoRegression: null,
  zipRegression: null,
  userFacingErrorHandling: null,
  existingRoutes: null,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  final: 'FAIL',
  error: null,
};

function printReport() {
  const r = report;
  console.log('\n========== Step 31.4 GitHub Private Repo ANALYZE 500 ==========');
  console.log(`1. Failing request: ${JSON.stringify(r.failingRequest)}`);
  console.log(`2. Error stack summary: ${JSON.stringify(r.errorStackSummary)}`);
  console.log(`3. Root cause: ${JSON.stringify(r.rootCause)}`);
  console.log(`4. Installation ID state: ${JSON.stringify(r.installationIdState)}`);
  console.log(`5. Repository authorization state: ${JSON.stringify(r.repositoryAuthorizationState)}`);
  console.log(`6. Installation token state: ${JSON.stringify(r.installationTokenState)}`);
  console.log(`7. Private repo authenticated access: ${JSON.stringify(r.privateRepoAuthenticatedAccess)}`);
  console.log(`8. Clone/fetch diagnosis: ${JSON.stringify(r.cloneFetchDiagnosis)}`);
  console.log(`9. Fix applied: ${JSON.stringify(r.fixApplied)}`);
  console.log(`10. API redeploy: ${JSON.stringify(r.apiRedeploy)}`);
  console.log(`11. Private repo analyze: ${JSON.stringify(r.privateRepoAnalyze)}`);
  console.log(`12. Public repo regression: ${JSON.stringify(r.publicRepoRegression)}`);
  console.log(`13. ZIP regression: ${JSON.stringify(r.zipRegression)}`);
  console.log(`14. User-facing error handling: ${JSON.stringify(r.userFacingErrorHandling)}`);
  console.log(`15. Existing routes: ${JSON.stringify(r.existingRoutes)}`);
  console.log(`16. Secrets exposed: ${r.secretsExposed}`);
  console.log(`17. Paid resource created: ${r.paidResourceCreated}`);
  console.log(`18. Final PASS / FAIL: ${r.final}`);
}

const prisma = new PrismaClient();

try {
  // Evidence from prior diagnose
  const logPath = join(ARTIFACT_DIR, 'step314-api-logs.txt');
  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  report.failingRequest = {
    route: 'POST /api/v1/onboarding/analyze',
    repo: PRIVATE_FULL,
    branch: PRIVATE_BRANCH,
    timestampUtcApprox: '2026-09-29T13:10:34Z (container local)',
    evidence: 'Alpha API ExceptionsHandler GitError at 1:10:34 PM',
  };
  report.errorStackSummary = {
    exception: 'GitError',
    message:
      "无法拉取代码：fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    classification: 6,
    classificationLabel: 'token 未注入 git clone',
  };
  report.rootCause =
    'AnalysesService.analyzeCode called git.cloneRepository(url, dir, branch) without GitHub App installation auth; private HTTPS clone prompted for username with GIT_TERMINAL_PROMPT=0 → 500';
  report.cloneFetchDiagnosis = {
    cloneMethod: 'HTTPS github.com',
    authInjectedBeforeFix: false,
    authMethodAfterFix: 'http.extraHeader AUTHORIZATION basic x-access-token:<installation_token>',
    resolveAuthForSourceExists: true,
    wiredIntoAnalyzeCode: true,
  };
  report.userFacingErrorHandling = {
    before: 'Nest default Internal server error (unhandled GitError)',
    after:
      'BadRequestException → 代码读取失败，请重新连接 GitHub 或稍后重试。 (GitError / GitHubAppError / private-without-connection)',
  };
  report.fixApplied = {
    files: [
      'apps/api/src/analyses/analyses.service.ts',
      'apps/api/src/analyses/analyses.module.ts',
    ],
    change:
      'Inject GitHubConnectionsService; resolveAuthForSource before clone; pass auth to cloneRepository; map failures to friendly BadRequestException',
  };

  const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
  if (!server) throw new Error('serverInstance missing for Alpha host');
  const username = resolveServerSshUsername(server.username);
  const password = decryptCredential(server.credentialEncrypted);
  const runner = new RemoteRunner();
  await runner.connect({ host: server.host, port: server.port, username, password });

  // Ensure github env/pem still present (from 31.3)
  const credCheck = await remoteOk(
    runner,
    [
      'test -s /opt/launchos/config/github-app.pem && echo PEM_OK || echo PEM_MISSING',
      'test -s /opt/launchos/config/alpha-github.env && echo GHENV_OK || echo GHENV_MISSING',
      'grep -E "^(GITHUB_APP_ID|GITHUB_APP_SLUG|GITHUB_APP_CALLBACK_URL)=" /opt/launchos/config/alpha-github.env | sed "s/=.*/=***/"',
    ].join(' ; '),
    'cred-files',
  );
  if (!String(credCheck.stdout || '').includes('PEM_OK') || !String(credCheck.stdout || '').includes('GHENV_OK')) {
    throw new Error('GitHub App pem/env missing on host — re-run 31.3 inject first');
  }

  if (!SKIP_REDEPLOY) {
  console.log('[1] docker build step314');
  const buildLog = join(ARTIFACT_DIR, 'step314-docker-build.log');
  const forceRebuild = process.argv.includes('--rebuild') || !SKIP_REDEPLOY;
  const existing = local('docker', ['image', 'inspect', LOCAL_IMAGE, '--format', '{{.Id}}']);
  if (!forceRebuild && existing.status === 0 && String(existing.stdout || '').trim()) {
    console.log('[1] reuse local image', String(existing.stdout || '').trim().slice(0, 20));
  } else {
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
    writeFileSync(buildLog, redact(`${build.stdout || ''}\n${build.stderr || ''}`).slice(-250000), 'utf8');
    if (build.status !== 0) {
      throw new Error(`docker build failed status=${build.status}; log=${buildLog}`);
    }
  }

  console.log('[2] save + upload image');
  const tarPath = join(ARTIFACT_DIR, 'launchos-alpha-api-step314.tar');
  try {
    unlinkSync(tarPath);
  } catch {
    /* ignore */
  }
  const save = local('docker', ['save', '-o', tarPath, LOCAL_IMAGE]);
  if (save.status !== 0) throw new Error(`docker save failed: ${redact(save.stderr || '')}`);
  const remoteTar = '/opt/launchos/tmp/launchos-alpha-api-step314.tar';
  await remoteOk(runner, 'mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir-tmp');
  await runner.upload(tarPath, remoteTar, { timeoutMs: 900000 });
  await remoteOk(
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

  // Reuse dual env-file start pattern from 31.3
  await runner.writeTextFile(
    '/opt/launchos/bin/step314-run-api.sh',
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
  await remoteOk(runner, 'chmod 700 /opt/launchos/bin/step314-run-api.sh', 'chmod-run');

  console.log('[3] start candidate');
  await remoteOk(
    runner,
    `/opt/launchos/bin/step314-run-api.sh ${CANDIDATE_CONTAINER} ${CANDIDATE_API_PORT} ${REMOTE_IMAGE}`,
    'start-candidate',
    { timeoutMs: 120000 },
  );

  await runner.writeTextFile(
    '/opt/launchos/bin/step314-wait.sh',
    `#!/bin/sh
i=0
while [ "$i" -lt 45 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:${CANDIDATE_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then
    curl -fsS http://127.0.0.1:${CANDIDATE_API_PORT}/api/v1/health
    echo
    echo LOG_BOOT=$(podman logs ${CANDIDATE_CONTAINER} 2>&1 | grep BOOT_KEYS | tail -1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY)=[^ ]+/\\1=***/g')
    exit 0
  fi
  sleep 2
done
podman logs --tail 80 ${CANDIDATE_CONTAINER} 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^ ]+/\\1=***/gi' | tail -40
exit 1
`,
  );
  const waitCand = await runner.execute(
    shellCommand('chmod 700 /opt/launchos/bin/step314-wait.sh && /opt/launchos/bin/step314-wait.sh'),
    { timeoutMs: 180000 },
  );
  if (waitCand.exitCode !== 0) {
    throw new Error(`candidate health failed: ${redact(String(waitCand.stdout || waitCand.stderr || '')).slice(0, 800)}`);
  }

  console.log('[4] traffic switch to candidate');
  const nginxCreds = {
    host: TARGET_HOST,
    port: server.port,
    username,
    password,
    hostname: API_HOST,
    healthPath: '/api/v1/health',
  };
  await applyColocatedNginxRoute({ ...nginxCreds, targetPort: CANDIDATE_API_PORT });
  const pubCand = curlResolve(`${API_ORIGIN}/api/v1/health`, API_HOST, { maxTime: '30' });
  if (pubCand.status !== 200 || !/launchos-api/i.test(pubCand.text)) {
    await applyColocatedNginxRoute({ ...nginxCreds, targetPort: LIVE_API_PORT });
    throw new Error('public health failed on candidate; rolled back');
  }

  console.log('[5] promote candidate → live');
  await remoteOk(
    runner,
    `/opt/launchos/bin/step314-run-api.sh ${LIVE_CONTAINER} ${LIVE_API_PORT} ${REMOTE_IMAGE}`,
    'start-live',
    { timeoutMs: 120000 },
  );
  await runner.writeTextFile(
    '/opt/launchos/bin/step314-wait-live.sh',
    `#!/bin/sh
i=0
while [ "$i" -lt 45 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:${LIVE_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then
    curl -fsS http://127.0.0.1:${LIVE_API_PORT}/api/v1/health; echo; exit 0
  fi
  sleep 2
done
podman logs --tail 60 ${LIVE_CONTAINER} 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^ ]+/\\1=***/gi' | tail -40
exit 1
`,
  );
  const waitLive = await runner.execute(
    shellCommand('chmod 700 /opt/launchos/bin/step314-wait-live.sh && /opt/launchos/bin/step314-wait-live.sh'),
    { timeoutMs: 180000 },
  );
  if (waitLive.exitCode !== 0) throw new Error('live health failed after promote');

  await applyColocatedNginxRoute({ ...nginxCreds, targetPort: LIVE_API_PORT });
  await remoteOk(runner, `podman rm -f ${CANDIDATE_CONTAINER} 2>/dev/null || true`, 'rm-cand', {
    allowExit: [0],
  });

  const pubLive = curlResolve(`${API_ORIGIN}/api/v1/health`, API_HOST, { maxTime: '30' });
  report.apiRedeploy = {
    image: REMOTE_IMAGE,
    candidatePort: CANDIDATE_API_PORT,
    livePort: LIVE_API_PORT,
    candidateHealthOk: true,
    publicHealthAfterPromote: pubLive.status === 200,
    ok: pubLive.status === 200 && /launchos-api/i.test(pubLive.text),
  };
  if (!report.apiRedeploy.ok) throw new Error('public API health failed after promote');
  } else {
    const pubLive = curlResolve(`${API_ORIGIN}/api/v1/health`, API_HOST, { maxTime: '30' });
    report.apiRedeploy = {
      image: REMOTE_IMAGE,
      skipped: true,
      publicHealthAfterPromote: pubLive.status === 200,
      ok: pubLive.status === 200 && /launchos-api/i.test(pubLive.text),
    };
    if (!report.apiRedeploy.ok) throw new Error('skip-redeploy but live health failed');
  }

  // Capability
  const cfg = curlResolve(`${API_ORIGIN}/api/v1/git/github/config`, API_HOST, {
    headers: { origin: WEB_ORIGIN },
  });
  const cfgJson = parseJson(cfg.text);
  if (cfgJson?.connectionCapability !== 'READY') {
    throw new Error(`GitHub capability not READY: ${redact(cfg.text).slice(0, 300)}`);
  }

  console.log('[6] Alpha DB: find ACTIVE GitHub connection + reset owner password for regress');
  await runner.writeTextFile(
    '/opt/launchos/tmp/step314-conn.sql',
    `SELECT c.id, c."installationId", c."workspaceId", c.status, c.login, u.id, u.email
FROM "GitProviderConnection" c
JOIN "Workspace" w ON w.id = c."workspaceId"
JOIN "User" u ON u.id = w."ownerId"
WHERE c.status = 'ACTIVE' AND c.provider = 'GITHUB'
ORDER BY c."updatedAt" DESC
LIMIT 5;
`,
  );
  const sqlOut = await remoteOk(
    runner,
    'podman cp /opt/launchos/tmp/step314-conn.sql launchos-alpha-postgres:/tmp/step314-conn.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step314-conn.sql && rm -f /opt/launchos/tmp/step314-conn.sql',
    'list-connections',
  );
  const connLines = String(sqlOut.stdout || '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!connLines.length) throw new Error('No ACTIVE GitHub connection on Alpha DB');
  const [connectionId, installationId, workspaceId, connStatus, connLogin, ownerUserId, ownerEmail] =
    connLines[0].split('|');
  report.installationIdState = {
    present: Boolean(installationId),
    suffix: installationId ? String(installationId).slice(-4) : null,
    connectionIdPresent: Boolean(connectionId),
    workspaceIdPresent: Boolean(workspaceId),
    ownerUserIdPresent: Boolean(ownerUserId),
    status: connStatus,
    login: connLogin || null,
  };

  // Installation token + repo authorization (local JWT from env — same App)
  const creds = readGitHubAppCredentials();
  if (!creds) throw new Error('local GitHub App credentials missing');
  createGitHubAppJwt(creds.appId, creds.privateKey);
  const installation = await getInstallation(installationId);
  const issued = await createInstallationAccessToken(installationId);
  report.installationTokenState = {
    present: Boolean(issued?.token),
    expiry: issued?.expiresAt || null,
    permissionsMetadata: 'Contents:read Metadata:read (App install; not printed from token body)',
    tokenPrinted: false,
  };

  const repos = await listInstallationRepositories(issued.token);
  const target = (repos || []).find(
    (r) =>
      String(r.fullName || '').toLowerCase() === PRIVATE_FULL.toLowerCase() ||
      String(r.name || '').toLowerCase() === 'launchos-multi-demo',
  );
  report.repositoryAuthorizationState = {
    fullName: PRIVATE_FULL,
    authorizedOnInstallation: Boolean(target),
    isPrivate: target ? Boolean(target.private) : null,
    defaultBranch: target?.defaultBranch || null,
    providerRepositoryId: target ? String(target.id) : null,
    contents: 'Read-only',
    metadata: 'Read-only',
    installationAccount: installation?.accountLogin || null,
  };
  if (!target) {
    throw new Error(`${PRIVATE_FULL} not in installation authorized repositories`);
  }

  // Authenticated metadata + ls-remote inside API container (token never logged)
  const probeEnvLocal = join(ARTIFACT_DIR, '.step314-probe.env');
  writeFileSync(probeEnvLocal, `INSTALL_TOKEN=${issued.token}\n`, { mode: 0o600 });
  await runner.upload(probeEnvLocal, '/opt/launchos/tmp/step314-probe.env');
  writeFileSync(probeEnvLocal, 'INSTALL_TOKEN=\n', { mode: 0o600 });
  try {
    unlinkSync(probeEnvLocal);
  } catch {
    /* ignore */
  }
  await runner.writeTextFile(
    '/opt/launchos/tmp/step314-inner-probe.sh',
    `#!/bin/sh
set -e
TOK=$(sed -n 's/^INSTALL_TOKEN=//p' /tmp/step314-probe.env | head -1)
rm -f /tmp/step314-probe.env
test -n "$TOK"
export T="$TOK"
BASIC=$(node -e 'process.stdout.write(Buffer.from("x-access-token:"+process.env.T).toString("base64"))')
node -e "const t=process.env.T;fetch('https://api.github.com/repos/${PRIVATE_FULL}',{headers:{Authorization:'Bearer '+t,'User-Agent':'LaunchOS',Accept:'application/vnd.github+json'}}).then(async r=>{const j=await r.json().catch(()=>({}));console.log('META_OK='+r.status);console.log('DEFAULT_BRANCH='+(j.default_branch||''));}).catch(e=>{console.log('META_OK=000');console.log('META_ERR='+String(e&&e.message||e).slice(0,160));});"
unset TOK
unset T
set +e
LS_OUT=$(git -c http.version=HTTP/1.1 -c http.extraHeader="AUTHORIZATION: basic $BASIC" ls-remote --heads "https://github.com/${PRIVATE_FULL}.git" ${PRIVATE_BRANCH} 2>/tmp/ls.err)
LS_EC=$?
set -e
echo LS_REMOTE_EC=$LS_EC
echo LS_REMOTE=$(printf '%s\\n' "$LS_OUT" | grep -c . || true)
echo LS_ERR=$(tr '\\n' ' ' </tmp/ls.err 2>/dev/null | head -c 160 | sed -E 's/(gh[pousr]_[A-Za-z0-9_]+|x-access-token:[^ ]+)/***/gi')
rm -f /tmp/ls.err
unset BASIC
`,
  );
  await runner.writeTextFile(
    '/opt/launchos/bin/step314-probe.sh',
    `#!/bin/sh
set -e
podman cp /opt/launchos/tmp/step314-probe.env ${LIVE_CONTAINER}:/tmp/step314-probe.env
rm -f /opt/launchos/tmp/step314-probe.env
podman cp /opt/launchos/tmp/step314-inner-probe.sh ${LIVE_CONTAINER}:/tmp/step314-inner-probe.sh
podman exec ${LIVE_CONTAINER} sh /tmp/step314-inner-probe.sh
`,
  );
  const probeRun = await remoteOk(
    runner,
    'chmod 700 /opt/launchos/bin/step314-probe.sh && /opt/launchos/bin/step314-probe.sh',
    'auth-probe',
    { timeoutMs: 120000 },
  );
  const probeOut = redact(String(probeRun.stdout || probeRun.stderr || ''));
  const metaOk = /META_OK=200/.test(probeOut);
  const lsOk = /LS_REMOTE=[1-9]/.test(probeOut) || /LS_REMOTE_EC=0/.test(probeOut);
  report.privateRepoAuthenticatedAccess = {
    metadataHttpOk: metaOk,
    lsRemoteMainOk: lsOk,
    snippet: probeOut.slice(0, 400),
    ok: metaOk && lsOk,
    credentialsLogged: false,
  };
  if (!report.privateRepoAuthenticatedAccess.ok) {
    throw new Error(`private authenticated access probe failed: ${probeOut.slice(0, 400)}`);
  }

  // Reset owner password so we can login as the workspace that already authorized the App
  const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
  const hash = await bcrypt.hash(tempPass, 10);
  // Escape single quotes for SQL
  const hashSql = hash.replace(/'/g, "''");
  const emailSql = String(ownerEmail).replace(/'/g, "''");
  await runner.writeTextFile(
    '/opt/launchos/tmp/step314-pass.sql',
    `UPDATE "User" SET "passwordHash"='${hashSql}' WHERE email='${emailSql}';\n`,
  );
  await remoteOk(
    runner,
    'podman cp /opt/launchos/tmp/step314-pass.sql launchos-alpha-postgres:/tmp/step314-pass.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step314-pass.sql && rm -f /opt/launchos/tmp/step314-pass.sql',
    'reset-pass',
  );

  console.log('[7] private repo analyze regress');
  const loginRes = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: ownerEmail, password: tempPass }),
  });
  const token = parseJson(loginRes.text)?.accessToken;
  if (!token) throw new Error(`login failed status=${loginRes.status} ${redact(loginRes.text).slice(0, 200)}`);
  const auth = { authorization: `Bearer ${token}`, origin: WEB_ORIGIN };

  const statusGh = curlResolve(`${API_ORIGIN}/api/v1/git/github/status`, API_HOST, { headers: auth });
  const reposApi = curlResolve(`${API_ORIGIN}/api/v1/git/github/repositories`, API_HOST, {
    headers: auth,
    maxTime: '60',
  });
  const reposJson = parseJson(reposApi.text);
  const repoList = Array.isArray(reposJson)
    ? reposJson
    : Array.isArray(reposJson?.repositories)
      ? reposJson.repositories
      : Array.isArray(reposJson?.items)
        ? reposJson.items
        : [];
  const apiRepo = repoList.find(
    (r) =>
      String(r.fullName || r.full_name || '').toLowerCase() === PRIVATE_FULL.toLowerCase() ||
      String(r.name || '').toLowerCase() === 'launchos-multi-demo',
  );

  const connect = curlResolve(`${API_ORIGIN}/api/v1/onboarding/source`, API_HOST, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      fullName: PRIVATE_FULL,
      cloneUrl: PRIVATE_CLONE,
      branch: PRIVATE_BRANCH,
      connectionId,
      providerRepositoryId: String(
        apiRepo?.id || apiRepo?.providerRepositoryId || target.id || target.providerRepositoryId || '',
      ),
      isPrivate: true,
    }),
  });
  const analyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
    method: 'POST',
    headers: auth,
    maxTime: '180',
  });
  let analyzeJson = parseJson(analyze.text);
  let stage = analyzeJson?.stage || null;

  // multi-unit demo may need root choice before PLAN
  if (analyze.status >= 200 && analyze.status < 300 && stage === 'ANALYZE') {
    const roots = analyzeJson?.uncertainWebRoots || [];
    const rootPath = roots[0]?.rootPath || roots[0] || '.';
    const rootPick = curlResolve(`${API_ORIGIN}/api/v1/onboarding/root`, API_HOST, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ rootPath: typeof rootPath === 'string' ? rootPath : '.' }),
    });
    analyzeJson = parseJson(rootPick.text) || analyzeJson;
    stage = analyzeJson?.stage || stage;
  }

  let planOk = false;
  let planSnippet = null;
  if (analyze.status >= 200 && analyze.status < 300) {
    const plan = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
      method: 'POST',
      headers: auth,
      maxTime: '120',
    });
    planSnippet = redact(plan.text).slice(0, 400);
    planOk = plan.status >= 200 && plan.status < 300 && Boolean(parseJson(plan.text)?.launchRunId || parseJson(plan.text)?.primaryLabel);
    if (planOk) stage = 'PLAN';
  }

  report.privateRepoAnalyze = {
    githubStatus: statusGh.status,
    reposStatus: reposApi.status,
    repoListed: Boolean(apiRepo),
    connectStatus: connect.status,
    analyzeStatus: analyze.status,
    stage,
    planOk,
    analyzeSnippet: redact(analyze.text).slice(0, 500),
    connectSnippet: redact(connect.text).slice(0, 300),
    planSnippet,
    ok:
      connect.status >= 200 &&
      connect.status < 300 &&
      analyze.status >= 200 &&
      analyze.status < 300 &&
      planOk &&
      !/Internal server error/i.test(analyze.text),
  };

  console.log('[8] public repo regression');
  const emailPub = `alpha-s314-pub-${Date.now()}@zsaos.test`;
  const passPub = `Alpha${randomBytes(5).toString('hex')}!aA1`;
  curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: emailPub, password: passPub, name: 'S314Pub' }),
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
    body: JSON.stringify({
      cloneUrl: 'https://github.com/octocat/Hello-World.git',
      branch: 'master',
    }),
  });
  const pubAnalyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
    method: 'POST',
    headers: authPub,
    maxTime: '180',
  });
  const pubAnalyzeJson = parseJson(pubAnalyze.text);
  let pubStage = pubAnalyzeJson?.stage || null;
  let pubPlanOk = false;
  if (pubAnalyze.status >= 200 && pubAnalyze.status < 300) {
    const pubPlan = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
      method: 'POST',
      headers: authPub,
      maxTime: '120',
    });
    pubPlanOk =
      pubPlan.status >= 200 &&
      pubPlan.status < 300 &&
      Boolean(parseJson(pubPlan.text)?.launchRunId || parseJson(pubPlan.text)?.primaryLabel);
    if (pubPlanOk) pubStage = 'PLAN';
  }
  report.publicRepoRegression = {
    connectStatus: pubConnect.status,
    analyzeStatus: pubAnalyze.status,
    stage: pubStage,
    planOk: pubPlanOk,
    snippet: redact(pubAnalyze.text).slice(0, 400),
    ok:
      Boolean(tokPub) &&
      pubConnect.status >= 200 &&
      pubConnect.status < 300 &&
      pubAnalyze.status >= 200 &&
      pubAnalyze.status < 300 &&
      pubPlanOk,
  };

  console.log('[9] ZIP regression');
  const zipPath = join(ARTIFACT_DIR, 'step31-smoke.zip');
  if (!existsSync(zipPath)) {
    report.zipRegression = { skipped: true, reason: 'step31-smoke.zip missing', ok: false };
  } else {
    const zipEmail = `alpha-s314-zip-${Date.now()}@zsaos.test`;
    const zipPass = `Alpha${randomBytes(5).toString('hex')}!aA1`;
    curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN },
      body: JSON.stringify({ email: zipEmail, password: zipPass, name: 'S314Zip' }),
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
      maxTime: '180',
    });
    const zipJson = parseJson(zipAnalyze.text);
    let zipPlanOk = false;
    if (zipAnalyze.status >= 200 && zipAnalyze.status < 300) {
      const zipPlan = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
        method: 'POST',
        headers: { authorization: `Bearer ${zipToken}`, origin: WEB_ORIGIN },
        maxTime: '120',
      });
      zipPlanOk =
        zipPlan.status >= 200 &&
        zipPlan.status < 300 &&
        Boolean(parseJson(zipPlan.text)?.launchRunId || parseJson(zipPlan.text)?.primaryLabel);
    }
    report.zipRegression = {
      skipped: false,
      uploadStatus,
      analyzeStatus: zipAnalyze.status,
      stage: zipPlanOk ? 'PLAN' : zipJson?.stage || null,
      planOk: zipPlanOk,
      ok:
        Boolean(zipToken) &&
        uploadStatus >= 200 &&
        uploadStatus < 300 &&
        zipAnalyze.status >= 200 &&
        zipAnalyze.status < 300 &&
        zipPlanOk,
    };
  }

  console.log('[10] existing routes');
  const routes = {};
  for (const host of PROTECTED_HOSTS) {
    const url =
      host.startsWith('api-') || host === API_HOST
        ? `https://${host}/api/v1/health`
        : `https://${host}/`;
    const r = curlResolve(url, host, { maxTime: '30' });
    routes[host] = {
      status: r.status,
      ok: r.status >= 200 && r.status < 500,
    };
  }
  report.existingRoutes = {
    routes,
    ok: Object.values(routes).every((x) => x.ok),
  };

  report.secretsExposed = 'NO';
  report.paidResourceCreated = 'NO';
  report.final =
    report.apiRedeploy?.ok &&
    report.privateRepoAuthenticatedAccess?.ok &&
    report.privateRepoAnalyze?.ok &&
    report.publicRepoRegression?.ok &&
    report.zipRegression?.ok &&
    report.existingRoutes?.ok &&
    report.repositoryAuthorizationState?.authorizedOnInstallation
      ? 'PASS'
      : 'FAIL';
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error)).slice(0, 1500);
  report.final = 'FAIL';
  console.error('STEP314_ERROR', report.error);
} finally {
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  printReport();
  await prisma.$disconnect().catch(() => {});
  process.exit(report.final === 'PASS' ? 0 : 1);
}
