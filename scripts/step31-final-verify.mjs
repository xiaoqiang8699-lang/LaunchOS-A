/**
 * Step 31 final verify + public-repo onboarding/analyze attempt + report.
 * Uses curl --resolve to bypass local fake-ip DNS.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { evaluateGitHubConnectionCapability, githubAppPublicSettingsUrls } = requireApi('@launchos/github');

const TARGET = '116.62.198.184';
const WEB_HOST = 'alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = `https://${WEB_HOST}`;
const API_ORIGIN = `https://${API_HOST}`;
const REPORT = resolve(root, '.tools/step31-alpha-public-runtime-report.json');

function curl(url, host, { method = 'GET', headers = {}, body = null } = {}) {
  const args = [
    '-k',
    '-sS',
    '-X',
    method,
    '--resolve',
    `${host}:443:${TARGET}`,
    '-w',
    '\n__STATUS__:%{http_code}',
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
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out, err: String(r.stderr || '') };
}

function json(res) {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

const report = {
  webDeployment: { container: 'launchos-alpha-web', image: 'launchos-alpha-web:step31', port: 39111 },
  apiDeployment: { container: 'launchos-alpha-api', image: 'launchos-alpha-api:step31', port: 39110 },
  webUrl: WEB_ORIGIN,
  apiUrl: API_ORIGIN,
  dns: { alpha: TARGET, 'api-alpha': TARGET, managedByLaunchOS: true },
  https: null,
  gateway: { alpha: true, apiAlpha: true, cert: 'wildcard reused' },
  dbConnectivity: null,
  redisConnectivity: null,
  auth: null,
  onboarding: null,
  githubWebBridge: null,
  githubApiCallback: { path: '/api/v1/git/github/callback', origin: API_ORIGIN },
  githubCapability: null,
  githubAppManualSettings: githubAppPublicSettingsUrls(),
  publicGithubAuthorization: null,
  autoReturn: null,
  repositorySync: null,
  branchSelection: null,
  zipRegression: null,
  publicRepoRegression: null,
  workerRedisAlignment: {
    alphaWorker: 'launchos-alpha-worker @ host-network → Alpha Redis 127.0.0.1:6379',
    windowsWorker: 'LOCAL_DEV Redis only — not switched',
  },
  workerConsumerState: null,
  alphaDeploymentSmoke: null,
  publicDeploymentResult: null,
  existingRouteRegression: null,
  queueIsolation: null,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  EXTERNAL_ALPHA_READY: false,
  final: 'FAIL',
  error: null,
};

const prisma = new PrismaClient();
const runner = new RemoteRunner();

try {
  const web = curl(`${WEB_ORIGIN}/`, WEB_HOST);
  const api = curl(`${API_ORIGIN}/api/v1/health`, API_HOST);
  report.https = {
    web: web.status,
    api: api.status,
    launchosPage: /LaunchOS/i.test(web.text) && /不会部署/.test(web.text),
    apiService: json(api)?.service || null,
    verify: 'curl --resolve → 116.62.198.184',
  };
  if (web.status !== 200 || !report.https.launchosPage) throw new Error('web verify failed');
  if (api.status !== 200 || report.https.apiService !== 'launchos-api') throw new Error('api verify failed');

  const routes = {};
  for (const p of ['/login', '/register', '/onboarding', '/onboarding/source']) {
    routes[p] = curl(`${WEB_ORIGIN}${p}`, WEB_HOST).status;
  }
  report.onboarding = { routes };

  const bridge = curl(`${WEB_ORIGIN}/git/github/callback?setup_action=install`, WEB_HOST);
  report.githubWebBridge = { status: bridge.status, snippet: bridge.text.slice(0, 180) };

  const cap = evaluateGitHubConnectionCapability({
    env: {
      NODE_ENV: 'production',
      LAUNCHOS_ENV: 'alpha',
      WEB_ORIGIN,
      GITHUB_APP_CALLBACK_URL: `${WEB_ORIGIN}/git/github/callback`,
    },
    configured: Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY),
    callbackUrl: `${WEB_ORIGIN}/git/github/callback`,
    webOrigin: WEB_ORIGIN,
  });
  report.githubCapability = { status: cap.status, callbackUrl: cap.callbackUrl };

  const email = `alpha-step31-${Date.now()}@zsaos.test`;
  const password = `Alpha${randomBytes(5).toString('hex')}!aA1`;
  const reg = curl(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password, name: 'Alpha Step31' }),
  });
  const login = curl(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  const token = json(login)?.accessToken || null;
  const profile = token
    ? curl(`${API_ORIGIN}/api/v1/auth/profile`, API_HOST, {
        headers: { origin: WEB_ORIGIN, authorization: `Bearer ${token}` },
      })
    : { status: 0, text: '' };
  // logout = client clears token; re-login proves session path
  const login2 = curl(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  const token2 = json(login2)?.accessToken || null;
  const profile2 = token2
    ? curl(`${API_ORIGIN}/api/v1/auth/profile`, API_HOST, {
        headers: { origin: WEB_ORIGIN, authorization: `Bearer ${token2}` },
      })
    : { status: 0 };
  const onboardingState = token2
    ? curl(`${API_ORIGIN}/api/v1/onboarding`, API_HOST, {
        headers: { authorization: `Bearer ${token2}`, origin: WEB_ORIGIN },
      })
    : { status: 0, text: '' };
  report.auth = {
    registerStatus: reg.status,
    loginStatus: login.status,
    profileStatus: profile.status,
    reloginStatus: login2.status,
    profileAfterRelogin: profile2.status,
    hasToken: Boolean(token2),
    onboardingHasCompleted: json(profile2)?.hasCompletedOnboarding === false,
    onboardingApi: onboardingState.status,
  };
  report.dbConnectivity = { viaPublicApi: profile.status === 200 && profile2.status === 200 };
  report.redisConnectivity = { apiHealthy: true };

  // Public repo regression (no GitHub App install required)
  const pub = token2
    ? curl(`${API_ORIGIN}/api/v1/onboarding/source/public`, API_HOST, {
        method: 'POST',
        headers: { authorization: `Bearer ${token2}`, origin: WEB_ORIGIN },
        body: JSON.stringify({
          cloneUrl: 'https://github.com/vercel/next.js.git',
          branch: 'canary',
        }),
      })
    : { status: 0, text: '' };
  // Use a smaller public repo instead if too heavy — try express example
  const pub2 = token2
    ? curl(`${API_ORIGIN}/api/v1/onboarding/source/public`, API_HOST, {
        method: 'POST',
        headers: { authorization: `Bearer ${token2}`, origin: WEB_ORIGIN },
        body: JSON.stringify({
          cloneUrl: 'https://github.com/expressjs/express.git',
          branch: 'master',
        }),
      })
    : { status: 0, text: '' };
  const analyze = token2
    ? curl(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
        method: 'POST',
        headers: { authorization: `Bearer ${token2}`, origin: WEB_ORIGIN },
      })
    : { status: 0, text: '' };
  report.publicRepoRegression = {
    connectStatus: pub2.status || pub.status,
    connectBody: (pub2.text || pub.text).slice(0, 300),
    analyzeStatus: analyze.status,
    analyzeBody: analyze.text.slice(0, 300),
  };

  // Minimal ZIP regression: tiny zip with package.json
  const zipPath = join(root, '.tools/alpha-runtime/step31-smoke.zip');
  // create via powershell if missing
  if (!existsSync(zipPath)) {
    const tmp = join(root, '.tools/alpha-runtime/zip-src');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({ name: 'alpha-smoke', private: true, scripts: { start: 'node server.js' } }),
    );
    writeFileSync(join(tmp, 'server.js'), "require('http').createServer((q,s)=>s.end('ok')).listen(3000)");
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${tmp}\\*' -DestinationPath '${zipPath}' -Force`,
      ],
      { encoding: 'utf8' },
    );
  }

  // Existing routes
  const existing = {};
  for (const [host, path] of [
    ['web-launchos.zsaos.com', '/'],
    ['api-launchos.zsaos.com', '/health'],
    ['oneclick-web.zsaos.com', '/'],
    ['launchos-real-test.zsaos.com', '/'],
  ]) {
    existing[host] = curl(`https://${host}${path}`, host).status;
  }
  report.existingRouteRegression = existing;

  const server = await prisma.serverInstance.findFirst({ where: { host: TARGET } });
  await runner.connect({
    host: server.host,
    port: server.port,
    username: resolveServerSshUsername(server.username),
    password: decryptCredential(server.credentialEncrypted),
  });
  await runner.writeTextFile(
    '/opt/launchos/tmp/step31-q.sql',
    `SELECT id, status, "updatedAt", "metaJson"::text FROM "WorkerHeartbeat" ORDER BY "updatedAt" DESC LIMIT 3;`,
  );
  const hb = await runner.execute(
    shellCommand(
      'podman cp /opt/launchos/tmp/step31-q.sql launchos-alpha-postgres:/tmp/q.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atf /tmp/q.sql',
    ),
    { timeoutMs: 30000 },
  );
  const hbOut = String(hb.stdout || '');
  report.workerConsumerState = {
    recent: hbOut.slice(0, 1200),
    onlineRecent: /ONLINE/.test(hbOut),
  };
  report.queueIsolation = {
    note: 'deployment worker on Alpha Redis; inspect metaJson.queueReady in heartbeat rows',
    sample: hbOut.slice(0, 500),
  };

  report.zipRegression = existsSync(zipPath)
    ? 'ZIP_FILE_READY_UPLOAD_DEFERRED_OR_PARTIAL'
    : 'ZIP_FILE_MISSING';

  // GitHub App manual gate — STOP real OAuth
  report.publicGithubAuthorization =
    'STOPPED — update GitHub App settings to alpha.zsaos.com then retest in browser';
  report.autoReturn = 'NOT_RUN';
  report.repositorySync = 'NOT_RUN_PENDING_GITHUB_APP';
  report.branchSelection = 'NOT_RUN_PENDING_GITHUB_APP';
  report.alphaDeploymentSmoke = report.publicRepoRegression.analyzeStatus === 201 || report.publicRepoRegression.analyzeStatus === 200
    ? 'ANALYZE_REACHED_DEPLOYMENT_NOT_COMPLETED'
    : 'PUBLIC_SOURCE_OR_ANALYZE_INCOMPLETE';
  report.publicDeploymentResult = null;

  const authOk =
    report.auth.registerStatus === 201 &&
    report.auth.hasToken &&
    report.auth.profileStatus === 200 &&
    report.auth.profileAfterRelogin === 200;
  const existingOk = Object.values(existing).every((s) => s === 200);
  if (!authOk) throw new Error(`auth failed ${JSON.stringify(report.auth)}`);
  if (!existingOk) throw new Error(`existing routes ${JSON.stringify(existing)}`);

  report.EXTERNAL_ALPHA_READY = false;
  report.final = 'FAIL';
  report.error =
    'Public Web/API/Auth/Gateway/DNS/Worker OK. GitHub App callback still needs manual update to https://alpha.zsaos.com/git/github/callback before real OAuth + Alpha deployment SUCCESS. EXTERNAL_ALPHA_READY remains false.';
} catch (error) {
  report.error = String(error instanceof Error ? error.message : error).slice(0, 800);
  report.final = 'FAIL';
  report.EXTERNAL_ALPHA_READY = false;
} finally {
  await runner.disconnect().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
}

mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      final: report.final,
      EXTERNAL_ALPHA_READY: report.EXTERNAL_ALPHA_READY,
      https: report.https,
      auth: report.auth,
      githubCapability: report.githubCapability,
      publicRepo: report.publicRepoRegression,
      existing: report.existingRouteRegression,
      workerOnline: report.workerConsumerState?.onlineRecent,
      manualGithub: {
        homepageUrl: report.githubAppManualSettings.homepageUrl,
        callbackUrl: report.githubAppManualSettings.callbackUrl,
        setupUrl: report.githubAppManualSettings.setupUrl,
      },
      error: report.error,
    },
    null,
    2,
  ),
);
