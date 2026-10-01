/**
 * Resume Step 31 after images loaded: DNS + gateway + verify.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { AlibabaCloudDnsProvider, applyColocatedNginxRoute, LAUNCHOS_PUBLIC_ENTRY_A_RRS } =
  requireDomain('@launchos/domain');
const { evaluateGitHubConnectionCapability, githubAppPublicSettingsUrls } = requireApi('@launchos/github');

console.log('DNS RR allowlist', LAUNCHOS_PUBLIC_ENTRY_A_RRS);

const TARGET_HOST = '116.62.198.184';
const WEB_HOST = 'alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = `https://${WEB_HOST}`;
const API_ORIGIN = `https://${API_HOST}`;
const API_PORT = 39110;
const WEB_PORT = 39111;
const PROTECTED = [
  'web-launchos.zsaos.com',
  'api-launchos.zsaos.com',
  'oneclick-web.zsaos.com',
  'launchos-real-test.zsaos.com',
];

function redact(s) {
  return String(s || '')
    .replace(/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/gi, 'postgresql://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN)=([^\s]+)/gi, '$1=***');
}

async function httpGet(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, { redirect: opts.redirect ?? 'follow', signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text, headers: Object.fromEntries(res.headers) };
  } finally {
    clearTimeout(timer);
  }
}

const report = {
  webDeployment: null,
  apiDeployment: null,
  webUrl: WEB_ORIGIN,
  apiUrl: API_ORIGIN,
  dns: null,
  https: null,
  gateway: null,
  dbConnectivity: null,
  redisConnectivity: null,
  auth: null,
  onboarding: null,
  githubWebBridge: null,
  githubApiCallback: null,
  githubCapability: null,
  githubAppManualSettings: githubAppPublicSettingsUrls(),
  publicGithubAuthorization: null,
  autoReturn: null,
  repositorySync: null,
  branchSelection: null,
  zipRegression: null,
  publicRepoRegression: null,
  workerRedisAlignment: null,
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
  const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
  if (!server) throw new Error('managed node missing');
  const username = resolveServerSshUsername(server.username);
  const password = decryptCredential(server.credentialEncrypted);
  await runner.connect({ host: server.host, port: server.port, username, password });

  // Ensure runtimes
  const status = await runner.execute(
    shellCommand(
      `podman ps --format '{{.Names}} {{.Status}}' | grep launchos-alpha || true; ss -lntp | grep -E ':39110|:39111' || true; curl -fsS http://127.0.0.1:${API_PORT}/api/v1/health || true; curl -fsS -o /dev/null -w 'WEB:%{http_code}\\n' http://127.0.0.1:${WEB_PORT}/ || true`,
    ),
    { timeoutMs: 60000 },
  );
  console.log('runtime_probe', status.stdout);

  // If containers missing, fail clearly
  if (!/launchos-alpha-api/.test(String(status.stdout || ''))) {
    throw new Error('alpha api container not running — re-run full step31 deploy');
  }

  // DNS
  const account = await prisma.providerAccount.findFirst({
    where: { provider: { type: 'ALIYUN_DNS' }, credentialEncrypted: { not: null } },
    include: { provider: true },
  });
  const raw = JSON.parse(decryptCredential(account.credentialEncrypted));
  const dns = new AlibabaCloudDnsProvider(
    { accessKey: raw.accessKey, secretKey: raw.secretKey },
    'zsaos.com',
  );
  const dnsOut = {};
  for (const rr of ['alpha', 'api-alpha']) {
    const existing = await dns.findARecordsReadOnly(rr);
    if (existing.length === 0) {
      const created = await dns.createARecord(rr, TARGET_HOST);
      dnsOut[rr] = { action: 'create', value: TARGET_HOST, recordId: created.recordId };
    } else if (existing[0].value !== TARGET_HOST) {
      await dns.updateARecord(existing[0].recordId, rr, TARGET_HOST);
      dnsOut[rr] = { action: 'update', value: TARGET_HOST, recordId: existing[0].recordId };
    } else {
      dnsOut[rr] = { action: 'noop', value: TARGET_HOST, recordId: existing[0].recordId };
    }
  }
  report.dns = dnsOut;

  // Gateway
  report.gateway = {
    api: await applyColocatedNginxRoute({
      host: TARGET_HOST,
      port: server.port,
      username,
      password,
      hostname: API_HOST,
      targetPort: API_PORT,
      healthPath: '/api/v1/health',
    }),
    web: await applyColocatedNginxRoute({
      host: TARGET_HOST,
      port: server.port,
      username,
      password,
      hostname: WEB_HOST,
      targetPort: WEB_PORT,
      healthPath: '/',
    }),
  };

  await new Promise((r) => setTimeout(r, 8000));

  const webHome = await httpGet(`${WEB_ORIGIN}/`);
  const apiHealth = await httpGet(`${API_ORIGIN}/api/v1/health`);
  report.https = {
    web: webHome.status,
    api: apiHealth.status,
    webHasLaunchOS: /LaunchOS/i.test(webHome.text),
    webHasTagline: /不会部署/.test(webHome.text),
    apiBody: apiHealth.text.slice(0, 180),
  };
  if (webHome.status !== 200 || !report.https.webHasLaunchOS || !report.https.webHasTagline) {
    throw new Error(`web public verify failed status=${webHome.status}`);
  }
  if (apiHealth.status !== 200 || /multi-api|v5/i.test(apiHealth.text)) {
    throw new Error(`api public verify failed status=${apiHealth.status} body=${apiHealth.text.slice(0, 120)}`);
  }

  report.webDeployment = { container: 'launchos-alpha-web', port: WEB_PORT };
  report.apiDeployment = { container: 'launchos-alpha-api', port: API_PORT };

  const routes = {};
  for (const p of ['/login', '/register', '/onboarding', '/onboarding/source']) {
    routes[p] = (await httpGet(`${WEB_ORIGIN}${p}`)).status;
  }
  report.onboarding = { routes };

  const bridge = await httpGet(`${WEB_ORIGIN}/git/github/callback`, { redirect: 'manual' });
  report.githubWebBridge = {
    status: bridge.status,
    location: bridge.headers.location || bridge.headers.Location || null,
  };
  report.githubApiCallback = { target: `${API_ORIGIN}/api/v1/git/github/callback` };

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
  const passwordUser = `Alpha${randomBytes(6).toString('hex')}!a`;
  const regRes = await fetch(`${API_ORIGIN}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: passwordUser, name: 'Alpha Step31' }),
  });
  const loginRes = await fetch(`${API_ORIGIN}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: passwordUser }),
  });
  const loginJson = await loginRes.json().catch(() => ({}));
  const token = loginJson.accessToken || loginJson.token || null;
  const meRes = token
    ? await fetch(`${API_ORIGIN}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${token}`, origin: WEB_ORIGIN },
      })
    : null;
  const logoutRes = token
    ? await fetch(`${API_ORIGIN}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, origin: WEB_ORIGIN },
      })
    : null;
  const login2 = await fetch(`${API_ORIGIN}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: passwordUser }),
  });
  report.auth = {
    registerStatus: regRes.status,
    loginStatus: loginRes.status,
    meStatus: meRes?.status ?? null,
    logoutStatus: logoutRes?.status ?? null,
    reloginStatus: login2.status,
    hasToken: Boolean(token),
  };
  report.dbConnectivity = { viaPublicApi: Boolean(token && meRes?.status === 200) };
  report.redisConnectivity = { apiHealthy: apiHealth.status === 200 };

  const existing = {};
  for (const host of PROTECTED) {
    const url = host.startsWith('api-') ? `https://${host}/health` : `https://${host}/`;
    existing[host] = (await httpGet(url)).status;
  }
  report.existingRouteRegression = existing;

  // Worker heartbeats from Alpha DB via public API isn't enough — query Alpha DB through SSH
  const hb = await runner.execute(
    shellCommand(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT COUNT(*) FROM \\"WorkerHeartbeat\\" WHERE \\"updatedAt\\" > NOW() - INTERVAL '2 minutes';" 2>/dev/null || podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ILIKE '%worker%';"`,
    ),
    { timeoutMs: 30000 },
  );
  report.workerConsumerState = { probe: String(hb.stdout || hb.stderr || '').trim().slice(0, 500) };
  report.workerRedisAlignment = {
    strategy: 'launchos-alpha-worker on host network → Alpha Redis; Windows worker stays on LOCAL_DEV Redis',
  };

  report.publicGithubAuthorization =
    cap.status === 'READY'
      ? 'MANUAL_REQUIRED_VERIFY_GITHUB_APP_SETTINGS'
      : 'BLOCKED';
  report.autoReturn = 'PENDING_MANUAL';
  report.repositorySync = 'PENDING_MANUAL';
  report.branchSelection = 'PENDING_MANUAL';
  report.zipRegression = 'PENDING_MANUAL';
  report.publicRepoRegression = 'PENDING_MANUAL';
  report.alphaDeploymentSmoke = 'PENDING';
  report.publicDeploymentResult = null;
  report.queueIsolation = report.workerConsumerState;

  const existingOk = Object.values(existing).every((s) => s === 200);
  const authOk = Boolean(report.auth.hasToken && report.auth.reloginStatus === 200);
  if (!existingOk) throw new Error(`existing route regression ${JSON.stringify(existing)}`);
  if (!authOk) throw new Error(`auth regression ${JSON.stringify(report.auth)}`);

  // Cannot set EXTERNAL_ALPHA_READY without GitHub real auth + deployment SUCCESS
  report.EXTERNAL_ALPHA_READY = false;
  report.final = 'FAIL';
  report.error =
    'Public runtime/DNS/gateway/auth OK; GitHub App manual settings + real OAuth + Alpha deployment SUCCESS still required';
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
      dns: report.dns,
      auth: report.auth,
      githubCapability: report.githubCapability,
      existing: report.existingRouteRegression,
      error: report.error,
    },
    null,
    2,
  ),
);
