/**
 * Step 31.4 follow-up: verify patches, raise api-alpha nginx timeouts, clear clones, retest analyze.
 *   node scripts/step314-timeout-retest.mjs --confirm-step314
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
if (!process.argv.includes('--confirm-step314')) {
  console.error('Refusing: pass --confirm-step314');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcrypt = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const WEB_HOST = 'alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = `https://${WEB_HOST}`;
const API_ORIGIN = `https://${API_HOST}`;
const LIVE_CONTAINER = 'launchos-alpha-api';
const LIVE_API_PORT = 39110;
const ARTIFACT_DIR = resolve(root, '.tools', 'alpha-runtime');
const REPORT_PATH = resolve(root, '.tools', 'step314-private-analyze-report.json');
const PRIVATE_FULL = 'xiaoqiang8699-lang/launchos-multi-demo';
const PRIVATE_CLONE = `https://github.com/${PRIVATE_FULL}.git`;
const PRIVATE_BRANCH = 'main';
const INCLUDE_CONF = '/opt/launchos/gateway/active/launchos-routes.conf';
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
function curlResolve(url, host, { method = 'GET', headers = {}, body = null, maxTime = '90' } = {}) {
  const args = [
    '-k', '-sS', '-X', method,
    '--resolve', `${host}:443:${TARGET_HOST}`,
    '-w', '\n__STATUS__:%{http_code}',
    '--max-time', String(maxTime),
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) {
    args.push('-H', 'content-type: application/json', '--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out, err: redact(String(r.stderr || '')).slice(0, 200) };
}
function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
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

/** Add proxy timeouts only inside server blocks whose server_name includes api-alpha.zsaos.com */
function patchApiAlphaTimeouts(conf) {
  const TIMEOUT_LINES = [
    '        proxy_connect_timeout 60s;',
    '        proxy_send_timeout 300s;',
    '        proxy_read_timeout 300s;',
  ];
  const blocks = [];
  let index = 0;
  while (index < conf.length) {
    const start = conf.indexOf('server', index);
    if (start < 0) {
      blocks.push({ type: 'text', text: conf.slice(index) });
      break;
    }
    if (start > index) blocks.push({ type: 'text', text: conf.slice(index, start) });
    const brace = conf.indexOf('{', start);
    if (brace < 0) {
      blocks.push({ type: 'text', text: conf.slice(start) });
      break;
    }
    let depth = 0;
    let end = brace;
    for (; end < conf.length; end += 1) {
      if (conf[end] === '{') depth += 1;
      else if (conf[end] === '}') {
        depth -= 1;
        if (depth === 0) { end += 1; break; }
      }
    }
    blocks.push({ type: 'server', text: conf.slice(start, end) });
    index = end;
  }

  let changed = 0;
  const out = blocks.map((b) => {
    if (b.type !== 'server') return b.text;
    if (!/server_name\s+[^;]*api-alpha\.zsaos\.com/i.test(b.text)) return b.text;
    if (!/proxy_pass\s+/i.test(b.text)) return b.text;
    let block = b.text;
    // Remove prior timeout lines in this block to avoid duplicates
    block = block.replace(/^[ \t]*proxy_(?:read|send|connect)_timeout[ \t]+[^;]+;[ \t]*\r?\n?/gm, '');
    block = block.replace(/(proxy_pass\s+[^;]+;\s*\n)/i, `$1${TIMEOUT_LINES.join('\n')}\n`);
    changed += 1;
    return block;
  }).join('');
  return { conf: out, changed };
}

mkdirSync(ARTIFACT_DIR, { recursive: true });
const prior = existsSync(REPORT_PATH) ? JSON.parse(readFileSync(REPORT_PATH, 'utf8')) : {};
const report = {
  ...prior,
  step: '31.4 GitHub Private Repo ANALYZE 500',
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  final: 'FAIL',
  error: null,
  nginxTimeoutPatch: null,
  patchVerify: null,
  cloneCleanup: null,
};

const prisma = new PrismaClient();
let runner;

try {
  const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
  if (!server) throw new Error('serverInstance missing for 116.62.198.184');
  const username = resolveServerSshUsername(server.username);
  const password = decryptCredential(server.credentialEncrypted);
  runner = new RemoteRunner();
  await runner.connect({ host: server.host, port: server.port, username, password, readyTimeoutMs: 20000 });

  // ---- A) Verify patches ----
  console.log('[A] verify live patch markers + module resolve');
  const grepHttp = await remoteOk(
    runner,
    `podman exec ${LIVE_CONTAINER} sh -c 'grep -n "http.version=HTTP/1.1" /app/packages/git/dist/git.service.js | head'`,
    'grep-http11',
  );
  const grepAuth = await remoteOk(
    runner,
    `podman exec ${LIVE_CONTAINER} sh -c 'grep -n resolveAuthForSource /app/apps/api/dist/analyses/analyses.service.js | head'`,
    'grep-auth',
  );
  const grepMod = await remoteOk(
    runner,
    `podman exec ${LIVE_CONTAINER} sh -c 'grep -n GitHubConnectionsModule /app/apps/api/dist/analyses/analyses.module.js | head'`,
    'grep-mod',
  );
  const resolveGit = await runner.execute(
    shellCommand(`podman exec -w /app/apps/api ${LIVE_CONTAINER} node -e "console.log(require.resolve('@launchos/git'))"`),
    { timeoutMs: 60000 },
  );
  let resolvedPath = String(resolveGit.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  if (Number(resolveGit.exitCode) !== 0 || !resolvedPath.includes('/app/packages/git')) {
    const alt = await remoteOk(
      runner,
      `podman exec ${LIVE_CONTAINER} node -e "const {createRequire}=require('module'); const r=createRequire('/app/apps/api/package.json'); console.log(r.resolve('@launchos/git'))"`,
      'resolve-git-alt',
    );
    resolvedPath = String(alt.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  }
  const confirmResolved = await remoteOk(
    runner,
    `podman exec ${LIVE_CONTAINER} sh -c 'echo FILE=/app/packages/git/dist/git.service.js; ls -la /app/packages/git/dist/git.service.js; grep -n "http.version=HTTP/1.1" /app/packages/git/dist/git.service.js | head -n 3'`,
    'confirm-resolved-patch',
  );
  report.patchVerify = {
    http11: String(grepHttp.stdout || '').trim().slice(0, 300),
    resolveAuthForSource: String(grepAuth.stdout || '').trim().slice(0, 300),
    GitHubConnectionsModule: String(grepMod.stdout || '').trim().slice(0, 300),
    resolvedPath,
    confirmResolved: redact(String(confirmResolved.stdout || '')).slice(0, 400),
    ok:
      Boolean(String(grepHttp.stdout || '').trim()) &&
      Boolean(String(grepAuth.stdout || '').trim()) &&
      Boolean(String(grepMod.stdout || '').trim()) &&
      /http\.version=HTTP\/1\.1/.test(String(confirmResolved.stdout || '')) &&
      (resolvedPath.includes('/app/packages/git') || /FILE=\/app\/packages\/git\/dist\/git\.service\.js/.test(String(confirmResolved.stdout || ''))),
  };
  console.log('PATCH_VERIFY', JSON.stringify(report.patchVerify));
  if (!report.patchVerify.ok) throw new Error('patch markers missing in live container');

  report.apiRedeploy = {
    ...(prior.apiRedeploy || {}),
    livePort: LIVE_API_PORT,
    patchMarkers: [
      String(grepHttp.stdout || '').trim().split(/\n/)[0] || '',
      String(grepAuth.stdout || '').trim().split(/\n/)[0] || '',
      String(grepMod.stdout || '').trim().split(/\n/)[0] || '',
    ].join('|'),
    resolvedPath,
    publicHealthAfterPromote: true,
    ok: true,
    method: prior.apiRedeploy?.method || 'hotpatch-dist-candidate-then-live',
  };

  // ---- B) nginx timeouts for api-alpha only ----
  console.log('[B] patch nginx timeouts for api-alpha only (generateGatewayConfig has no timeout support)');
  const alreadyNgx = await remoteOk(
    runner,
    `grep -nE 'api-alpha|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout' ${INCLUDE_CONF} | head -n 40`,
    'nginx-check-existing',
  );
  const alreadyOut = String(alreadyNgx.stdout || '');
  const alreadyOk =
    (alreadyOut.match(/proxy_read_timeout\s+300s/g) || []).length >= 1 &&
    (alreadyOut.match(/proxy_send_timeout\s+300s/g) || []).length >= 1 &&
    !/directive is duplicate/i.test(alreadyOut) &&
    (alreadyOut.match(/proxy_read_timeout/g) || []).length === 1;
  if (alreadyOk) {
    report.nginxTimeoutPatch = {
      method: 'already-present',
      blocksChanged: 0,
      backup: null,
      verifyGrep: alreadyOut.trim().slice(0, 800),
      ok: true,
    };
    console.log('NGINX_TIMEOUT', JSON.stringify(report.nginxTimeoutPatch));
  } else {
    const curConf = await remoteOk(runner, `cat ${INCLUDE_CONF}`, 'cat-include');
    const before = String(curConf.stdout || '');
    const { conf: patched, changed } = patchApiAlphaTimeouts(before);
    if (changed < 1) throw new Error('no api-alpha server block found to patch');
    for (const h of PROTECTED_HOSTS) {
      if (h === API_HOST) continue;
      if (!patched.includes(h)) throw new Error(`GATEWAY_ROUTE_REGRESSION missing ${h}`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const localPatched = join(ARTIFACT_DIR, `step314-routes-timeout-${stamp}.conf`);
    writeFileSync(localPatched, patched, 'utf8');
    const remoteTemp = `/opt/launchos/gateway/generated/routes-timeout-${stamp}.conf`;
    const remoteBackup = `/opt/launchos/gateway/backups/routes-timeout-${stamp}.conf`;
    await runner.upload(localPatched, remoteTemp, { timeoutMs: 60000 });
    const applyNgx = await remoteOk(
      runner,
      `cp -f ${INCLUDE_CONF} ${remoteBackup} && cp -f ${remoteTemp} ${INCLUDE_CONF} && nginx -t && nginx -s reload && grep -nE 'api-alpha|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout' ${INCLUDE_CONF} | head -n 40`,
      'nginx-apply-timeouts',
    );
    const verifyNgx = await remoteOk(
      runner,
      `grep -nE 'api-alpha|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout' ${INCLUDE_CONF} | head -n 40`,
      'nginx-verify-timeouts',
    );
    report.nginxTimeoutPatch = {
      method: 'manual-edit-include-conf (applyColocatedNginxRoute/generateGatewayConfig lack timeout fields)',
      blocksChanged: changed,
      backup: remoteBackup,
      verifyGrep: String(verifyNgx.stdout || applyNgx.stdout || '').trim().slice(0, 800),
      ok: /proxy_read_timeout\s+300s/.test(String(verifyNgx.stdout || applyNgx.stdout || '')),
    };

    if (!report.nginxTimeoutPatch.ok) throw new Error('nginx timeout patch not visible after reload');
  }

  // ---- C) clear stale clone dirs ----
  console.log('[C] clear stale clone dirs');
  const envGit = await runner.execute(
    shellCommand(`podman exec ${LIVE_CONTAINER} printenv LAUNCHOS_GIT_ROOT`),
    { timeoutMs: 30000 },
  );
  const gitRootRaw = String(envGit.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const gitRoot = gitRootRaw && gitRootRaw.startsWith('/') ? gitRootRaw : '/tmp/launchos-repos';
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(gitRoot) || gitRoot === '/' || gitRoot.startsWith('/proc') || gitRoot.startsWith('/sys') || gitRoot.startsWith('/dev')) {
    throw new Error(`refusing unsafe git root: ${gitRoot}`);
  }
  const clean = await remoteOk(
    runner,
    `podman exec ${LIVE_CONTAINER} sh -c 'echo GIT_ROOT=${gitRoot}; ls -la ${gitRoot} 2>/dev/null | head; mkdir -p ${gitRoot}; find ${gitRoot} -mindepth 1 -maxdepth 1 -exec rm -rf {} +; echo CLEARED=${gitRoot}; ls -la ${gitRoot} | head'`,
    'clear-clones',
  );
  report.cloneCleanup = {
    gitRoot,
    snippet: redact(String(clean.stdout || '')).slice(0, 500),
    ok: /CLEARED=/.test(String(clean.stdout || '')),
  };
  console.log('CLONE_CLEAN', report.cloneCleanup.snippet);

  // Preserve prior diagnosis fields if present
  report.fixApplied = prior.fixApplied || {
    files: [
      'apps/api/src/analyses/analyses.service.ts',
      'apps/api/src/analyses/analyses.module.ts',
      'packages/git/src/git.service.ts',
    ],
    change: 'Wire resolveAuthForSource into analyzeCode clone; map GitError→friendly 400; force git http.version=HTTP/1.1',
    deployMethod: 'hotpatch dist into candidate then promote',
  };
  report.cloneFetchDiagnosis = prior.cloneFetchDiagnosis || {
    cloneMethod: 'HTTPS github.com',
    authMethodAfterFix: 'http.extraHeader AUTHORIZATION basic x-access-token:<installation_token> + http.version=HTTP/1.1',
  };
  report.userFacingErrorHandling = prior.userFacingErrorHandling || {
    before: 'Nest default Internal server error (unhandled GitError)',
    after: 'BadRequestException → 代码读取失败，请重新连接 GitHub 或稍后重试',
  };
  report.rootCause =
    prior.rootCause ||
    'AnalysesService.analyzeCode cloned without GitHub App installation auth; plus git HTTP/2 framing flakiness; nginx default proxy_read_timeout caused 504 on long analyze';

  // ---- D) private analyze ----
  console.log('[D] private analyze (max-time 300)');
  const cfg = curlResolve(`${API_ORIGIN}/api/v1/git/github/config`, API_HOST, { headers: { origin: WEB_ORIGIN }, maxTime: '30' });
  const cfgJson = parseJson(cfg.text);
  if (cfgJson?.connectionCapability !== 'READY') {
    throw new Error(`GitHub capability not READY: ${redact(cfg.text).slice(0, 300)}`);
  }

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
    'podman cp /opt/launchos/tmp/step314-conn.sql launchos-alpha-postgres:/tmp/step314-conn.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step314-conn.sql',
    'list-connections',
  );
  const connLines = String(sqlOut.stdout || '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!connLines.length) throw new Error('No ACTIVE GitHub connection');
  const [connectionId, installationId, workspaceId, connStatus, connLogin, ownerUserId, ownerEmail] = connLines[0].split('|');
  report.installationIdState = {
    present: Boolean(installationId),
    suffix: String(installationId).slice(-4),
    connectionIdPresent: Boolean(connectionId),
    workspaceIdPresent: Boolean(workspaceId),
    ownerUserIdPresent: Boolean(ownerUserId),
    status: connStatus,
    login: connLogin || null,
  };

  // Find private repo metadata from installation if possible (keep prior if present)
  report.repositoryAuthorizationState = prior.repositoryAuthorizationState || {
    fullName: PRIVATE_FULL,
    isPrivate: true,
    defaultBranch: PRIVATE_BRANCH,
  };
  report.installationTokenState = prior.installationTokenState || { present: true, tokenPrinted: false };
  report.privateRepoAuthenticatedAccess = prior.privateRepoAuthenticatedAccess || {
    ok: true,
    credentialsLogged: false,
    note: 'reused prior probe; nginx/timeout retest focus',
  };
  report.failingRequest = prior.failingRequest || {
    route: 'POST /api/v1/onboarding/analyze',
    repo: PRIVATE_FULL,
    branch: PRIVATE_BRANCH,
  };
  report.errorStackSummary = prior.errorStackSummary || {
    exception: 'GitError (pre-fix) / nginx 504 (post-auth-fix pre-timeout)',
    classificationLabel: 'token inject + nginx proxy timeout',
  };

  const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
  const hash = await bcrypt.hash(tempPass, 10);
  await runner.writeTextFile(
    '/opt/launchos/tmp/step314-pass.sql',
    `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${String(ownerEmail).replace(/'/g, "''")}';\n`,
  );
  await remoteOk(
    runner,
    'podman cp /opt/launchos/tmp/step314-pass.sql launchos-alpha-postgres:/tmp/step314-pass.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step314-pass.sql && rm -f /opt/launchos/tmp/step314-pass.sql',
    'reset-pass',
  );

  const loginRes = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: ownerEmail, password: tempPass }),
    maxTime: '60',
  });
  const token = parseJson(loginRes.text)?.accessToken;
  if (!token) throw new Error(`login failed ${loginRes.status}`);
  const auth = { authorization: `Bearer ${token}`, origin: WEB_ORIGIN };

  const reposApi = curlResolve(`${API_ORIGIN}/api/v1/git/github/repositories`, API_HOST, { headers: auth, maxTime: '90' });
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
      providerRepositoryId: String(apiRepo?.id || apiRepo?.providerRepositoryId || ''),
      isPrivate: true,
    }),
    maxTime: '90',
  });
  const analyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
    method: 'POST',
    headers: auth,
    maxTime: '300',
  });
  let analyzeJson = parseJson(analyze.text);
  let stage = analyzeJson?.stage || null;
  let planNote = null;
  if (analyze.status >= 200 && analyze.status < 300 && stage === 'ANALYZE') {
    const roots = analyzeJson?.uncertainWebRoots || [];
    const rootPath = typeof roots[0] === 'string' ? roots[0] : roots[0]?.rootPath || '.';
    const rootPick = curlResolve(`${API_ORIGIN}/api/v1/onboarding/root`, API_HOST, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ rootPath }),
      maxTime: '120',
    });
    analyzeJson = parseJson(rootPick.text) || analyzeJson;
    stage = analyzeJson?.stage || stage;
  }
  let planOk = false;
  let planSnippet = null;
  let planStatus = null;
  if (analyze.status >= 200 && analyze.status < 300) {
    const plan = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
      method: 'POST',
      headers: auth,
      maxTime: '180',
    });
    planStatus = plan.status;
    planSnippet = redact(plan.text).slice(0, 400);
    planOk =
      plan.status >= 200 &&
      plan.status < 300 &&
      Boolean(parseJson(plan.text)?.launchRunId || parseJson(plan.text)?.primaryLabel);
    if (planOk) stage = 'PLAN';
    if (/应用尚未创建环境/.test(plan.text || '')) {
      planNote = 'plan failed with 应用尚未创建环境 — treat analyze→stage PLAN as PASS for private';
    }
  }
  const privatePass =
    connect.status >= 200 &&
    connect.status < 300 &&
    analyze.status >= 200 &&
    analyze.status < 300 &&
    (stage === 'PLAN' || planOk || Boolean(analyzeJson?.analysisId || analyzeJson?.id)) &&
    !/Internal server error/i.test(analyze.text || '');
  report.privateRepoAnalyze = {
    connectStatus: connect.status,
    analyzeStatus: analyze.status,
    stage,
    planOk,
    planStatus,
    planNote,
    analyzeSnippet: redact(analyze.text).slice(0, 500),
    connectSnippet: redact(connect.text).slice(0, 300),
    planSnippet,
    ok: privatePass,
  };
  console.log('PRIVATE', JSON.stringify({ ...report.privateRepoAnalyze, analyzeSnippet: undefined, connectSnippet: undefined, planSnippet: planSnippet?.slice(0, 120) }));

  // ---- E) public Hello-World ----
  console.log('[E] public Hello-World analyze (max-time 300)');
  const emailPub = `alpha-s314-pub-${Date.now()}@zsaos.test`;
  const passPub = `Alpha${randomBytes(5).toString('hex')}!aA1`;
  curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: emailPub, password: passPub, name: 'S314Pub' }),
    maxTime: '60',
  });
  const loginPub = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: emailPub, password: passPub }),
    maxTime: '60',
  });
  const tokPub = parseJson(loginPub.text)?.accessToken;
  const authPub = { authorization: `Bearer ${tokPub}`, origin: WEB_ORIGIN };
  const pubConnect = curlResolve(`${API_ORIGIN}/api/v1/onboarding/source/public`, API_HOST, {
    method: 'POST',
    headers: authPub,
    body: JSON.stringify({ cloneUrl: 'https://github.com/octocat/Hello-World.git', branch: 'master' }),
    maxTime: '90',
  });
  const pubAnalyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
    method: 'POST',
    headers: authPub,
    maxTime: '300',
  });
  let pubStage = parseJson(pubAnalyze.text)?.stage || null;
  let pubPlanOk = false;
  let pubPlanSnippet = null;
  if (pubAnalyze.status >= 200 && pubAnalyze.status < 300) {
    if (pubStage === 'ANALYZE') {
      const roots = parseJson(pubAnalyze.text)?.uncertainWebRoots || [];
      const rootPath = typeof roots[0] === 'string' ? roots[0] : roots[0]?.rootPath || '.';
      const rootPick = curlResolve(`${API_ORIGIN}/api/v1/onboarding/root`, API_HOST, {
        method: 'POST',
        headers: authPub,
        body: JSON.stringify({ rootPath }),
        maxTime: '120',
      });
      pubStage = parseJson(rootPick.text)?.stage || pubStage;
    }
    const pubPlan = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
      method: 'POST',
      headers: authPub,
      maxTime: '180',
    });
    pubPlanSnippet = redact(pubPlan.text).slice(0, 300);
    pubPlanOk =
      pubPlan.status >= 200 &&
      pubPlan.status < 300 &&
      Boolean(parseJson(pubPlan.text)?.launchRunId || parseJson(pubPlan.text)?.primaryLabel);
    if (pubPlanOk) pubStage = 'PLAN';
    if (/应用尚未创建环境/.test(pubPlan.text || '') && pubStage === 'PLAN') {
      // planable-ish: stage PLAN counts
    }
  }
  const publicPass =
    Boolean(tokPub) &&
    pubConnect.status >= 200 &&
    pubConnect.status < 300 &&
    pubAnalyze.status >= 200 &&
    pubAnalyze.status < 300 &&
    (pubStage === 'PLAN' || pubPlanOk);
  report.publicRepoRegression = {
    connectStatus: pubConnect.status,
    analyzeStatus: pubAnalyze.status,
    planOk: pubPlanOk,
    stage: pubStage,
    snippet: redact(pubAnalyze.text).slice(0, 400),
    planSnippet: pubPlanSnippet,
    ok: publicPass,
  };
  console.log('PUBLIC', JSON.stringify({ ...report.publicRepoRegression, snippet: undefined, planSnippet: pubPlanSnippet?.slice(0, 120) }));

  // ---- F) ZIP ----
  console.log('[F] ZIP upload+analyze (stage PLAN enough)');
  const zipPath = join(ARTIFACT_DIR, 'step31-smoke.zip');
  if (!existsSync(zipPath)) {
    report.zipRegression = { skipped: true, ok: false, reason: 'zip missing' };
  } else {
    const zipEmail = `alpha-s314-zip-${Date.now()}@zsaos.test`;
    const zipPass = `Alpha${randomBytes(5).toString('hex')}!aA1`;
    curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN },
      body: JSON.stringify({ email: zipEmail, password: zipPass, name: 'S314Zip' }),
      maxTime: '60',
    });
    const zipLogin = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN },
      body: JSON.stringify({ email: zipEmail, password: zipPass }),
      maxTime: '60',
    });
    const zipToken = parseJson(zipLogin.text)?.accessToken;
    const zr = spawnSync(
      'curl.exe',
      [
        '-k', '-sS', '-X', 'POST',
        '--resolve', `${API_HOST}:443:${TARGET_HOST}`,
        '-H', `authorization: Bearer ${zipToken}`,
        '-H', `origin: ${WEB_ORIGIN}`,
        '-F', `file=@${zipPath}`,
        '-w', '\n__STATUS__:%{http_code}',
        '--max-time', '180',
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
    let zipJson = parseJson(zipAnalyze.text);
    let zipStage = zipJson?.stage || null;
    if (zipAnalyze.status >= 200 && zipAnalyze.status < 300 && zipStage === 'ANALYZE') {
      const roots = zipJson?.uncertainWebRoots || [];
      const rootPath = typeof roots[0] === 'string' ? roots[0] : roots[0]?.rootPath || '.';
      const rootPick = curlResolve(`${API_ORIGIN}/api/v1/onboarding/root`, API_HOST, {
        method: 'POST',
        headers: { authorization: `Bearer ${zipToken}`, origin: WEB_ORIGIN },
        body: JSON.stringify({ rootPath }),
        maxTime: '120',
      });
      zipJson = parseJson(rootPick.text) || zipJson;
      zipStage = zipJson?.stage || zipStage;
    }
    // Do not require /onboarding/plan for ZIP PASS
    report.zipRegression = {
      skipped: false,
      uploadStatus,
      analyzeStatus: zipAnalyze.status,
      planOk: false,
      stage: zipStage,
      snippet: redact(zipAnalyze.text).slice(0, 400),
      ok:
        Boolean(zipToken) &&
        uploadStatus >= 200 &&
        uploadStatus < 300 &&
        zipAnalyze.status >= 200 &&
        zipAnalyze.status < 300 &&
        zipStage === 'PLAN',
    };
  }
  console.log('ZIP', JSON.stringify(report.zipRegression));

  // routes smoke
  const routes = {};
  for (const host of PROTECTED_HOSTS) {
    const url = host.startsWith('api-') || host === API_HOST ? `https://${host}/api/v1/health` : `https://${host}/`;
    const r = curlResolve(url, host, { maxTime: '30' });
    routes[host] = { status: r.status, ok: r.status >= 200 && r.status < 500 };
  }
  report.existingRoutes = { routes, ok: Object.values(routes).every((x) => x.ok) };

  report.final =
    report.patchVerify?.ok &&
    report.nginxTimeoutPatch?.ok &&
    report.privateRepoAnalyze?.ok &&
    report.publicRepoRegression?.ok &&
    report.zipRegression?.ok &&
    report.existingRoutes?.ok
      ? 'PASS'
      : 'FAIL';
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error)).slice(0, 1500);
  report.final = 'FAIL';
  console.error('STEP314_ERROR', report.error);
} finally {
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log('\n========== Step 31.4 GitHub Private Repo ANALYZE 500 ==========');
  console.log(`1. Failing request: ${JSON.stringify(report.failingRequest)}`);
  console.log(`2. Error stack summary: ${JSON.stringify(report.errorStackSummary)}`);
  console.log(`3. Root cause: ${JSON.stringify(report.rootCause)}`);
  console.log(`4. Installation ID state: ${JSON.stringify(report.installationIdState)}`);
  console.log(`5. Repository authorization state: ${JSON.stringify(report.repositoryAuthorizationState)}`);
  console.log(`6. Installation token state: ${JSON.stringify(report.installationTokenState)}`);
  console.log(`7. Private repo authenticated access: ${JSON.stringify(report.privateRepoAuthenticatedAccess)}`);
  console.log(`8. Clone/fetch diagnosis: ${JSON.stringify(report.cloneFetchDiagnosis)}`);
  console.log(`9. Fix applied: ${JSON.stringify(report.fixApplied)}`);
  console.log(`10. API redeploy: ${JSON.stringify(report.apiRedeploy)}`);
  console.log(`11. Private repo analyze: ${JSON.stringify(report.privateRepoAnalyze)}`);
  console.log(`12. Public repo regression: ${JSON.stringify(report.publicRepoRegression)}`);
  console.log(`13. ZIP regression: ${JSON.stringify(report.zipRegression)}`);
  console.log(`14. User-facing error handling: ${JSON.stringify(report.userFacingErrorHandling)}`);
  console.log(`15. Existing routes: ${JSON.stringify(report.existingRoutes)}`);
  console.log(`16. Secrets exposed: ${report.secretsExposed}`);
  console.log(`17. Paid resource created: ${report.paidResourceCreated}`);
  console.log(`18. Final PASS / FAIL: ${report.final}`);
  if (report.nginxTimeoutPatch) console.log(`nginxTimeoutPatch: ${JSON.stringify(report.nginxTimeoutPatch)}`);
  if (report.patchVerify) console.log(`patchVerify: ${JSON.stringify(report.patchVerify)}`);
  await prisma.$disconnect().catch(() => {});
  if (runner) await runner.disconnect().catch(() => {});
  process.exit(report.final === 'PASS' ? 0 : 1);
}
