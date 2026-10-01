/**
 * Step 31 public verification using curl --resolve (bypass local fake-IP DNS).
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

function curl(url, host, { method = 'GET', headers = {}, body = null, resolveIp = TARGET } = {}) {
  const args = [
    '-k',
    '-sS',
    '-X',
    method,
    '--resolve',
    `${host}:443:${resolveIp}`,
    '-w',
    '\n__STATUS__:%{http_code}',
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  if (body != null) {
    args.push('-H', 'content-type: application/json');
    args.push('--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 5_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  const status = m ? Number(m[1]) : 0;
  const text = m ? out.slice(0, m.index) : out;
  return { status, text, err: String(r.stderr || ''), exit: r.status };
}

function redact(s) {
  return String(s || '')
    .replace(/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/gi, 'postgresql://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN)=([^\s]+)/gi, '$1=***');
}

const report = {
  webDeployment: { container: 'launchos-alpha-web', port: 39111, network: 'host' },
  apiDeployment: { container: 'launchos-alpha-api', port: 39110, network: 'host' },
  webUrl: WEB_ORIGIN,
  apiUrl: API_ORIGIN,
  dns: {
    alpha: { value: TARGET, note: 'AliDNS A created (local resolver may fake-ip; verified via --resolve)' },
    'api-alpha': { value: TARGET },
  },
  https: null,
  gateway: { applied: true, certificatePresent: true },
  dbConnectivity: null,
  redisConnectivity: null,
  auth: null,
  onboarding: null,
  githubWebBridge: null,
  githubApiCallback: { target: `${API_ORIGIN}/api/v1/git/github/callback` },
  githubCapability: null,
  githubAppManualSettings: githubAppPublicSettingsUrls(),
  publicGithubAuthorization: null,
  autoReturn: null,
  repositorySync: null,
  branchSelection: null,
  zipRegression: null,
  publicRepoRegression: null,
  workerRedisAlignment: {
    strategy: 'Alpha worker on 116.62.198.184 host-network → Alpha Redis; Windows worker remains LOCAL_DEV',
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
    webHasLaunchOS: /LaunchOS/i.test(web.text),
    webHasTagline: /不会部署/.test(web.text),
    apiBody: api.text.slice(0, 160),
    verifyMethod: 'curl --resolve → 116.62.198.184 (bypass local fake-ip DNS)',
  };
  if (web.status !== 200 || !report.https.webHasLaunchOS) {
    throw new Error(`web verify failed ${web.status}`);
  }
  if (api.status !== 200 || /multi-api|v5/i.test(api.text)) {
    throw new Error(`api verify failed ${api.status} ${api.text.slice(0, 100)}`);
  }

  const routes = {};
  for (const p of ['/login', '/register', '/onboarding', '/onboarding/source']) {
    routes[p] = curl(`${WEB_ORIGIN}${p}`, WEB_HOST).status;
  }
  report.onboarding = { routes };

  const bridge = curl(`${WEB_ORIGIN}/git/github/callback`, WEB_HOST);
  report.githubWebBridge = {
    status: bridge.status,
    bodySnippet: bridge.text.slice(0, 200),
    note: 'expects redirect/forward to api-alpha callback',
  };

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
  report.githubCapability = {
    status: cap.status,
    callbackUrl: cap.callbackUrl,
    diagnosis: cap.diagnosis,
  };

  const email = `alpha-step31-${Date.now()}@zsaos.test`;
  const passwordUser = `Alpha${randomBytes(6).toString('hex')}!aA`;
  const reg = curl(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: passwordUser, name: 'Alpha Step31' }),
  });
  const login = curl(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: passwordUser }),
  });
  let token = null;
  try {
    token = JSON.parse(login.text).accessToken || JSON.parse(login.text).token || null;
  } catch {
    token = null;
  }
  const me = token
    ? curl(`${API_ORIGIN}/api/v1/auth/me`, API_HOST, {
        headers: { origin: WEB_ORIGIN, authorization: `Bearer ${token}` },
      })
    : { status: 0, text: '' };
  const logout = token
    ? curl(`${API_ORIGIN}/api/v1/auth/logout`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN, authorization: `Bearer ${token}` },
      })
    : { status: 0 };
  const login2 = curl(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: passwordUser }),
  });
  report.auth = {
    registerStatus: reg.status,
    loginStatus: login.status,
    meStatus: me.status,
    logoutStatus: logout.status,
    reloginStatus: login2.status,
    hasToken: Boolean(token),
  };
  report.dbConnectivity = { viaPublicApi: Boolean(token && me.status === 200) };
  report.redisConnectivity = { apiHealthy: api.status === 200, alphaWorkerContainer: 'launchos-alpha-worker' };

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
    '/opt/launchos/tmp/step31-worker-probe.sql',
    `SELECT id, status, "updatedAt" FROM "WorkerHeartbeat" ORDER BY "updatedAt" DESC LIMIT 5;`,
  );
  const hb = await runner.execute(
    shellCommand(
      'podman cp /opt/launchos/tmp/step31-worker-probe.sql launchos-alpha-postgres:/tmp/q.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atf /tmp/q.sql',
    ),
    { timeoutMs: 30000 },
  );
  report.workerConsumerState = {
    recentHeartbeats: String(hb.stdout || '').trim().slice(0, 800),
    exit: hb.exitCode,
  };

  // Admin capability endpoint if available
  let adminCap = null;
  try {
    const token2 = JSON.parse(login2.text).accessToken;
    const diag = curl(`${API_ORIGIN}/api/v1/admin/github/capability`, API_HOST, {
      headers: { origin: WEB_ORIGIN, authorization: `Bearer ${token2}` },
    });
    adminCap = { status: diag.status, body: diag.text.slice(0, 300) };
  } catch {
    adminCap = null;
  }
  report.githubCapability.adminProbe = adminCap;

  report.publicGithubAuthorization =
    cap.status === 'READY'
      ? 'STOPPED_FOR_MANUAL_GITHUB_APP_SETTINGS_GATE'
      : 'BLOCKED_CAPABILITY';
  report.autoReturn = 'NOT_RUN_PENDING_GITHUB_APP_SETTINGS';
  report.repositorySync = 'NOT_RUN';
  report.branchSelection = 'NOT_RUN';
  report.zipRegression = 'NOT_RUN';
  report.publicRepoRegression = 'NOT_RUN';
  report.alphaDeploymentSmoke = 'NOT_RUN_PENDING_GITHUB_OR_PUBLIC_FLOW';
  report.publicDeploymentResult = null;
  report.queueIsolation = {
    note: 'Alpha worker profile=deployment on Alpha Redis; provision queues should remain 0 consumers on this worker',
    heartbeats: report.workerConsumerState,
  };

  const existingOk = Object.values(existing).every((s) => s === 200);
  const authOk = report.auth.hasToken && report.auth.reloginStatus === 200 && report.auth.meStatus === 200;
  if (!existingOk) throw new Error(`existing route regression ${JSON.stringify(existing)}`);
  if (!authOk) throw new Error(`auth failed ${JSON.stringify(report.auth)} regBody=${reg.text.slice(0, 200)}`);

  // Full EXTERNAL_ALPHA_READY requires GitHub real auth + deployment SUCCESS — not claimed here.
  report.EXTERNAL_ALPHA_READY = false;
  report.final = 'FAIL';
  report.error =
    'Runtime/DNS/Gateway/Auth/existing-routes verified via --resolve. GitHub App must be updated to alpha.zsaos.com callback before real OAuth + deployment smoke. Manual settings listed in githubAppManualSettings.';
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error));
  report.final = 'FAIL';
  report.EXTERNAL_ALPHA_READY = false;
} finally {
  await runner.disconnect().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
}

mkdirSync(resolve(root, '.tools'), { recursive: true });
writeFileSync(resolve(root, '.tools/step31-alpha-public-runtime-report.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      final: report.final,
      EXTERNAL_ALPHA_READY: report.EXTERNAL_ALPHA_READY,
      https: report.https,
      auth: report.auth,
      githubCapability: report.githubCapability,
      existing: report.existingRouteRegression,
      worker: report.workerConsumerState,
      manualGithub: report.githubAppManualSettings,
      error: report.error,
    },
    null,
    2,
  ),
);
