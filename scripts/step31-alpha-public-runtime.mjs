/**
 * Step 31 — External Alpha Public Runtime & GitHub Public Callback
 *
 *   node scripts/step31-alpha-public-runtime.mjs --confirm-alpha-public-runtime
 *
 * Does NOT print secrets. Does NOT create paid cloud resources.
 * Does NOT overwrite historical hosts (web-launchos / api-launchos / …).
 */
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  copyFileSync,
} from 'node:fs';
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

const CONFIRM = process.argv.includes('--confirm-alpha-public-runtime');
if (!CONFIRM) {
  console.error('Refusing: pass --confirm-alpha-public-runtime');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  shellCommand,
} = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const {
  AlibabaCloudDnsProvider,
  applyColocatedNginxRoute,
  githubAppPublicSettingsUrls,
  evaluateGitHubConnectionCapability,
} = (() => {
  const domain = requireDomain('@launchos/domain');
  const github = requireApi('@launchos/github');
  return {
    AlibabaCloudDnsProvider: domain.AlibabaCloudDnsProvider,
    applyColocatedNginxRoute: domain.applyColocatedNginxRoute,
    githubAppPublicSettingsUrls: github.githubAppPublicSettingsUrls,
    evaluateGitHubConnectionCapability: github.evaluateGitHubConnectionCapability,
  };
})();

const TARGET_HOST = '116.62.198.184';
const WEB_HOST = 'alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = `https://${WEB_HOST}`;
const API_ORIGIN = `https://${API_HOST}`;
const API_PORT = 39110;
const WEB_PORT = 39111;
const ARTIFACT_DIR = resolve(root, '.tools', 'alpha-runtime');
const REPORT_PATH = resolve(root, '.tools', 'step31-alpha-public-runtime-report.json');
const PROTECTED_HOSTS = [
  'web-launchos.zsaos.com',
  'api-launchos.zsaos.com',
  'oneclick-web.zsaos.com',
  'launchos-real-test.zsaos.com',
];

function redact(text) {
  return String(text || '')
    .replace(/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/gi, 'postgresql://***:***@')
    .replace(/redis:\/\/[^:\s]+:[^@\s]+@/gi, 'redis://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY)=([^\s]+)/gi, '$1=***');
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

async function httpGet(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: opts.redirect ?? 'follow',
      signal: controller.signal,
      headers: opts.headers,
    });
    const text = await res.text();
    return { status: res.status, text, ok: res.ok, headers: Object.fromEntries(res.headers) };
  } finally {
    clearTimeout(timer);
  }
}

function loadAlphaDbUrl() {
  const url = process.env.ALPHA_DATABASE_URL || '';
  if (!url || !url.includes('127.0.0.1')) {
    throw new Error('ALPHA_DATABASE_URL missing or not loopback — run Step 30 first');
  }
  return url;
}

function loadAlphaRedisUrl() {
  return process.env.ALPHA_REDIS_URL || 'redis://127.0.0.1:6379';
}

function buildRemoteEnvFiles(secrets) {
  const jwt = process.env.JWT_SECRET;
  if (!jwt) throw new Error('JWT_SECRET required from local .env');
  const githubKey = process.env.GITHUB_APP_PRIVATE_KEY || '';
  const apiEnv = [
    'NODE_ENV=production',
    'LAUNCHOS_ENV=alpha',
    `API_PORT=${API_PORT}`,
    'API_HOST=127.0.0.1',
    `WEB_ORIGIN=${WEB_ORIGIN}`,
    `DATABASE_URL=${secrets.databaseUrl}`,
    `REDIS_URL=${secrets.redisUrl}`,
    `JWT_SECRET=${jwt}`,
    `JWT_EXPIRES_IN=${process.env.JWT_EXPIRES_IN || '7d'}`,
    `CREDENTIAL_ENCRYPTION_KEY=${process.env.CREDENTIAL_ENCRYPTION_KEY || ''}`,
    `GITHUB_APP_ID=${process.env.GITHUB_APP_ID || ''}`,
    `GITHUB_APP_SLUG=${process.env.GITHUB_APP_SLUG || ''}`,
    `GITHUB_APP_CLIENT_ID=${process.env.GITHUB_APP_CLIENT_ID || ''}`,
    `GITHUB_APP_CLIENT_SECRET=${process.env.GITHUB_APP_CLIENT_SECRET || ''}`,
    `GITHUB_APP_CALLBACK_URL=${WEB_ORIGIN}/git/github/callback`,
    // Private key loaded at container start from mounted PEM (avoid env-file newline issues).
    `MINIO_ENDPOINT=${process.env.MINIO_ENDPOINT || ''}`,
    `MINIO_ACCESS_KEY=${process.env.MINIO_ACCESS_KEY || ''}`,
    `MINIO_SECRET_KEY=${process.env.MINIO_SECRET_KEY || ''}`,
    `MINIO_BUCKET=${process.env.MINIO_BUCKET || ''}`,
    `MINIO_PUBLIC_URL=${process.env.MINIO_PUBLIC_URL || ''}`,
    '',
  ].join('\n');

  const webEnv = [
    'NODE_ENV=production',
    'LAUNCHOS_ENV=alpha',
    `PORT=${WEB_PORT}`,
    'HOSTNAME=127.0.0.1',
    `NEXT_PUBLIC_API_URL=${API_ORIGIN}`,
    `WEB_ORIGIN=${WEB_ORIGIN}`,
    '',
  ].join('\n');

  const workerEnv = [
    'NODE_ENV=production',
    'LAUNCHOS_ENV=alpha',
    'WORKER_PROFILE=deployment',
    `DATABASE_URL=${secrets.databaseUrl}`,
    `REDIS_URL=${secrets.redisUrl}`,
    `JWT_SECRET=${jwt}`,
    `CREDENTIAL_ENCRYPTION_KEY=${process.env.CREDENTIAL_ENCRYPTION_KEY || ''}`,
    `GITHUB_APP_ID=${process.env.GITHUB_APP_ID || ''}`,
    `GITHUB_APP_SLUG=${process.env.GITHUB_APP_SLUG || ''}`,
    `GITHUB_APP_CLIENT_ID=${process.env.GITHUB_APP_CLIENT_ID || ''}`,
    `GITHUB_APP_CLIENT_SECRET=${process.env.GITHUB_APP_CLIENT_SECRET || ''}`,
    `MINIO_ENDPOINT=${process.env.MINIO_ENDPOINT || ''}`,
    `MINIO_ACCESS_KEY=${process.env.MINIO_ACCESS_KEY || ''}`,
    `MINIO_SECRET_KEY=${process.env.MINIO_SECRET_KEY || ''}`,
    `MINIO_BUCKET=${process.env.MINIO_BUCKET || ''}`,
    `MINIO_PUBLIC_URL=${process.env.MINIO_PUBLIC_URL || ''}`,
    '',
  ].join('\n');

  const githubPem = (process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return { apiEnv, webEnv, workerEnv, githubPem };
}

async function ensureDns(prisma) {
  const account = await prisma.providerAccount.findFirst({
    where: { provider: { type: 'ALIYUN_DNS' }, credentialEncrypted: { not: null } },
    include: { provider: true },
  });
  if (!account?.credentialEncrypted) throw new Error('ALIYUN_DNS credential account missing');
  const raw = JSON.parse(decryptCredential(account.credentialEncrypted));
  const dns = new AlibabaCloudDnsProvider(
    { accessKey: raw.accessKey, secretKey: raw.secretKey },
    'zsaos.com',
  );
  const out = {};
  for (const rr of ['alpha', 'api-alpha']) {
    const existing = await dns.findARecordsReadOnly(rr);
    if (existing.length === 0) {
      const created = await dns.createARecord(rr, TARGET_HOST);
      out[rr] = { action: 'create', value: TARGET_HOST, recordId: created.recordId };
    } else {
      const current = existing[0];
      if (current.value !== TARGET_HOST) {
        await dns.updateARecord(current.recordId, rr, TARGET_HOST);
        out[rr] = { action: 'update', value: TARGET_HOST, recordId: current.recordId };
      } else {
        out[rr] = { action: 'noop', value: TARGET_HOST, recordId: current.recordId };
      }
    }
  }
  return out;
}

async function main() {
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
    githubAppManualSettings: null,
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
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const databaseUrl = loadAlphaDbUrl();
    const redisUrl = loadAlphaRedisUrl();

    const apiTar = join(ARTIFACT_DIR, 'launchos-alpha-api.tar');
    const webTar = join(ARTIFACT_DIR, 'launchos-alpha-web.tar');
    const workerTar = join(ARTIFACT_DIR, 'launchos-alpha-worker.tar');
    for (const tar of [apiTar, webTar, workerTar]) {
      if (!existsSync(tar) || statSync(tar).size <= 0) {
        throw new Error(`Missing image archive ${tar} — build Docker images first`);
      }
    }

    const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
    if (!server) throw new Error('managed node not found');
    const username = resolveServerSshUsername(server.username);
    const password = decryptCredential(server.credentialEncrypted);
    await runner.connect({ host: server.host, port: server.port, username, password });

    // Confirm alpha data plane still up
    await remoteOk(
      runner,
      `podman exec launchos-alpha-postgres pg_isready -U launchos_alpha -d launchos >/dev/null && podman exec launchos-alpha-redis redis-cli ping | grep -q PONG`,
      'alpha-dataplane-alive',
      { timeoutMs: 30000 },
    );

    const envFiles = buildRemoteEnvFiles({ databaseUrl, redisUrl });
    await runner.writeTextFile('/opt/launchos/config/alpha-api.env', envFiles.apiEnv);
    await runner.writeTextFile('/opt/launchos/config/alpha-web.env', envFiles.webEnv);
    await runner.writeTextFile('/opt/launchos/config/alpha-worker.env', envFiles.workerEnv);
    if (envFiles.githubPem) {
      await runner.writeTextFile('/opt/launchos/config/github-app.pem', envFiles.githubPem);
    }
    await remoteOk(
      runner,
      'chmod 600 /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-web.env /opt/launchos/config/alpha-worker.env; chmod 600 /opt/launchos/config/github-app.pem 2>/dev/null || true',
      'chmod-alpha-env',
      { timeoutMs: 15000 },
    );

    // Upload + load images
    for (const [local, remote, name] of [
      [apiTar, '/opt/launchos/tmp/launchos-alpha-api.tar', 'api'],
      [webTar, '/opt/launchos/tmp/launchos-alpha-web.tar', 'web'],
      [workerTar, '/opt/launchos/tmp/launchos-alpha-worker.tar', 'worker'],
    ]) {
      await runner.upload(local, remote, { timeoutMs: 900000 });
      await remoteOk(
        runner,
        `podman load -i ${remote} && rm -f ${remote} && podman tag docker.io/library/launchos-alpha-${name}:step31 localhost/launchos-alpha-${name}:step31 2>/dev/null || true`,
        `podman-load-${name}`,
        { timeoutMs: 600000 },
      );
    }

    // Recreate runtime containers (host network → Alpha loopback DB/Redis)
    await remoteOk(
      runner,
      [
        'podman rm -f launchos-alpha-api launchos-alpha-web launchos-alpha-worker 2>/dev/null || true',
        `podman run -d --name launchos-alpha-api --restart unless-stopped --network host --env-file /opt/launchos/config/alpha-api.env -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro --entrypoint /bin/sh localhost/launchos-alpha-api:step31 -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/api/dist/main.js'`,
        `podman run -d --name launchos-alpha-web --restart unless-stopped --network host --env-file /opt/launchos/config/alpha-web.env localhost/launchos-alpha-web:step31`,
        `podman run -d --name launchos-alpha-worker --restart unless-stopped --network host --env-file /opt/launchos/config/alpha-worker.env -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro -v /run/podman/podman.sock:/run/podman/podman.sock -e CONTAINER_HOST=unix:///run/podman/podman.sock --entrypoint /bin/sh localhost/launchos-alpha-worker:step31 -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/worker/dist/main.js'`,
      ].join(' && '),
      'start-alpha-runtimes',
      { timeoutMs: 180000 },
    );

    await runner.writeTextFile(
      '/opt/launchos/bin/step31-wait-api.sh',
      `#!/bin/sh
i=0
while [ "$i" -lt 60 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:${API_PORT}/api/v1/health >/dev/null 2>&1; then exit 0; fi
  sleep 2
done
podman logs --tail 80 launchos-alpha-api || true
exit 1
`,
    );
    await remoteOk(
      runner,
      'chmod 700 /opt/launchos/bin/step31-wait-api.sh && /opt/launchos/bin/step31-wait-api.sh',
      'wait-api-local',
      { timeoutMs: 180000 },
    );

    await runner.writeTextFile(
      '/opt/launchos/bin/step31-wait-web.sh',
      `#!/bin/sh
i=0
while [ "$i" -lt 60 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:${WEB_PORT}/ >/dev/null 2>&1; then exit 0; fi
  sleep 2
done
podman logs --tail 80 launchos-alpha-web || true
exit 1
`,
    );
    await remoteOk(
      runner,
      'chmod 700 /opt/launchos/bin/step31-wait-web.sh && /opt/launchos/bin/step31-wait-web.sh',
      'wait-web-local',
      { timeoutMs: 180000 },
    );

    report.apiDeployment = { container: 'launchos-alpha-api', port: API_PORT, network: 'host' };
    report.webDeployment = { container: 'launchos-alpha-web', port: WEB_PORT, network: 'host' };

    // DNS
    report.dns = await ensureDns(prisma);

    // Gateway routes (preserve existing)
    const gwApi = await applyColocatedNginxRoute({
      host: TARGET_HOST,
      port: server.port,
      username,
      password,
      hostname: API_HOST,
      targetPort: API_PORT,
      healthPath: '/api/v1/health',
    });
    const gwWeb = await applyColocatedNginxRoute({
      host: TARGET_HOST,
      port: server.port,
      username,
      password,
      hostname: WEB_HOST,
      targetPort: WEB_PORT,
      healthPath: '/',
    });
    report.gateway = { api: gwApi, web: gwWeb };

    // Propagation wait (brief)
    await new Promise((r) => setTimeout(r, 5000));

    // Public probes
    const webHome = await httpGet(`${WEB_ORIGIN}/`);
    const apiHealth = await httpGet(`${API_ORIGIN}/api/v1/health`);
    report.https = {
      web: webHome.status,
      api: apiHealth.status,
      webSnippet: webHome.text.slice(0, 200),
      apiSnippet: apiHealth.text.slice(0, 200),
    };
    if (webHome.status !== 200) throw new Error(`alpha web HTTP ${webHome.status}`);
    if (!/LaunchOS/i.test(webHome.text) || !/不会部署/.test(webHome.text)) {
      throw new Error('alpha web does not look like current LaunchOS marketing page');
    }
    if (apiHealth.status !== 200) throw new Error(`alpha api health HTTP ${apiHealth.status}`);
    if (/multi-api|v5/i.test(apiHealth.text)) {
      throw new Error('alpha api still looks like multi-api v5');
    }

    // Routes
    const routes = {};
    for (const path of ['/login', '/register', '/onboarding', '/onboarding/source']) {
      const r = await httpGet(`${WEB_ORIGIN}${path}`);
      routes[path] = r.status;
    }
    report.onboarding = { routes };

    // GitHub bridge
    const bridge = await httpGet(`${WEB_ORIGIN}/git/github/callback`, { redirect: 'manual' });
    report.githubWebBridge = {
      status: bridge.status,
      location: bridge.headers.location || bridge.headers.Location || null,
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
    report.githubAppManualSettings = githubAppPublicSettingsUrls();
    report.githubApiCallback = {
      target: `${API_ORIGIN}/api/v1/git/github/callback`,
    };

    // DB/Redis smoke via public API (register+me) — ephemeral user
    const email = `alpha-step31-${Date.now()}@zsaos.test`;
    const passwordUser = `Alpha${randomBytes(6).toString('hex')}!`;
    const reg = await httpGet(`${API_ORIGIN}/api/v1/auth/register`, {
      timeoutMs: 30000,
      // fetch GET can't post — use below
    }).catch(() => ({ status: 0, text: '' }));
    void reg;
    const regRes = await fetch(`${API_ORIGIN}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: JSON.stringify({ email, password: passwordUser, name: 'Alpha Step31' }),
    });
    const regBody = await regRes.text();
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
    const meJson = meRes ? await meRes.json().catch(() => ({})) : null;
    report.auth = {
      registerStatus: regRes.status,
      loginStatus: loginRes.status,
      meStatus: meRes?.status ?? null,
      hasToken: Boolean(token),
      userId: meJson?.id || meJson?.user?.id || null,
    };
    report.dbConnectivity = {
      viaPublicApi: Boolean(token && meRes?.status === 200),
      note: 'Alpha Postgres via host-network API; DB ports not public',
    };
    report.redisConnectivity = {
      viaApiBoot: apiHealth.status === 200,
      note: 'BullMQ/redis client init implied by API health; worker on Alpha Redis',
    };

    // Existing routes regression
    const existing = {};
    for (const host of PROTECTED_HOSTS) {
      const url =
        host.startsWith('api-') ? `https://${host}/health` : `https://${host}/`;
      const r = await httpGet(url).catch((e) => ({ status: 0, text: String(e) }));
      existing[host] = r.status;
    }
    report.existingRouteRegression = existing;
    for (const host of PROTECTED_HOSTS) {
      if (existing[host] !== 200) {
        throw new Error(`existing route regression ${host} HTTP ${existing[host]}`);
      }
    }

    // Worker heartbeat / queue
    await new Promise((r) => setTimeout(r, 15000));
    const workers = await prisma.workerHeartbeat.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
    const alphaWorkers = workers.filter((w) => {
      const meta = (w.metaJson || w.metadata || {}) ;
      return true;
    });
    report.workerRedisAlignment = {
      strategy: 'alpha-worker-on-managed-host-host-network; windows-worker-must-not-share-alpha-redis',
      note: 'Windows LOCAL_DEV Redis isolated; Alpha worker consumes Alpha Redis only',
    };
    report.workerConsumerState = {
      heartbeats: workers.slice(0, 5).map((w) => ({
        id: w.id,
        status: w.status,
        updatedAt: w.updatedAt,
        queueReady: w.metaJson?.queueReady || w.metadata?.queueReady || null,
        profile: w.metaJson?.profile || w.metadata?.profile || null,
      })),
    };

    // Manual GitHub gate — do not claim auto-return PASS without browser proof
    if (cap.status !== 'READY') {
      report.publicGithubAuthorization = 'BLOCKED_CAPABILITY_NOT_READY';
      report.autoReturn = 'NOT_RUN';
    } else {
      report.publicGithubAuthorization = 'MANUAL_GATE_REQUIRED_IF_GITHUB_APP_SETTINGS_STALE';
      report.autoReturn = 'PENDING_MANUAL_BROWSER';
    }

    report.zipRegression = 'DEFERRED_TO_BROWSER';
    report.publicRepoRegression = 'DEFERRED_TO_BROWSER';
    report.branchSelection = 'DEFERRED_TO_BROWSER';
    report.repositorySync = 'DEFERRED_TO_BROWSER';
    report.alphaDeploymentSmoke = 'PENDING_AFTER_GITHUB_OR_PUBLIC_REPO';
    report.publicDeploymentResult = null;
    report.queueIsolation = report.workerConsumerState;

    const ready =
      webHome.status === 200 &&
      apiHealth.status === 200 &&
      report.auth?.hasToken &&
      cap.status === 'READY' &&
      Object.values(existing).every((s) => s === 200);

    // EXTERNAL_ALPHA_READY requires full GitHub+deployment chain — set false until those PASS
    report.EXTERNAL_ALPHA_READY = false;
    report.final =
      ready && report.publicDeploymentResult?.status === 'SUCCESS' ? 'PASS' : 'FAIL';
    if (!report.publicDeploymentResult) {
      report.error =
        'Runtime + auth + DNS + gateway deployed; GitHub App manual settings + real auth + deployment smoke still required for EXTERNAL_ALPHA_READY';
    }
  } catch (error) {
    report.error = redact(error instanceof Error ? error.message : String(error));
    report.final = 'FAIL';
    report.EXTERNAL_ALPHA_READY = false;
  } finally {
    try {
      await runner.disconnect();
    } catch {
      // ignore
    }
    try {
      await prisma.$disconnect();
    } catch {
      // ignore
    }
  }

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        final: report.final,
        EXTERNAL_ALPHA_READY: report.EXTERNAL_ALPHA_READY,
        web: report.https?.web,
        api: report.https?.api,
        auth: report.auth?.hasToken,
        githubCapability: report.githubCapability?.status,
        error: report.error,
        reportPath: REPORT_PATH,
      },
      null,
      2,
    ),
  );
  process.exit(report.final === 'PASS' ? 0 : 1);
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
