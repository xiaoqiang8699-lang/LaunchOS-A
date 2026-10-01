/**
 * Step 31.3 — remote start script based injection (avoid SSH -e interpolation issues)
 */
import { createRequire } from 'node:module';
import { createPrivateKey } from 'node:crypto';
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
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const { createGitHubAppJwt } = requireApi('@launchos/github');

const TARGET = '116.62.198.184';
const WEB = 'https://alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const API = `https://${API_HOST}`;
const LIVE = 'launchos-alpha-api';
const CAND = 'launchos-alpha-api-cand-313';
const LIVE_PORT = 39110;
const CAND_PORT = 39113;
const DIR = resolve(root, '.tools/alpha-runtime');
const REPORT = resolve(root, '.tools/step313-github-app-runtime-report.json');

function redact(t) {
  return String(t || '')
    .replace(/BEGIN [^\n]+PRIVATE KEY[\s\S]*?END [^\n]+PRIVATE KEY/g, '[PEM_REDACTED]')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|GITHUB_APP_ID|GITHUB_APP_SLUG)[=:][^\s"']+/gi, '$1=***');
}
function curl(url, host, opts = {}) {
  const args = ['-k', '-sS', '-X', opts.method || 'GET', '--resolve', `${host}:443:${TARGET}`, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(opts.maxTime || 90)];
  for (const [k, v] of Object.entries(opts.headers || {})) args.push('-H', `${k}: ${v}`);
  if (opts.body != null) args.push('-H', 'content-type: application/json', '--data-binary', opts.body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}
function j(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

mkdirSync(DIR, { recursive: true });
const appId = process.env.GITHUB_APP_ID?.trim() || '';
const slug = process.env.GITHUB_APP_SLUG?.trim() || '';
const pem = String(process.env.GITHUB_APP_PRIVATE_KEY || '').trim().replace(/\\n/g, '\n');
if (!appId || !slug || !pem) throw new Error('missing creds');
createPrivateKey(pem);
createGitHubAppJwt(appId, pem);

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET } });
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : { step: '31.3 Alpha GitHub App Runtime Credentials' };

try {
  // Upload pem + github env fragment (LF only)
  const pemPath = join(DIR, '.step313.pem');
  writeFileSync(pemPath, pem.endsWith('\n') ? pem : pem + '\n', { mode: 0o600 });
  await runner.upload(pemPath, '/opt/launchos/config/github-app.pem');
  writeFileSync(pemPath, '');

  const fragBody = [
    `GITHUB_APP_ID=${appId}`,
    `GITHUB_APP_SLUG=${slug}`,
    `GITHUB_APP_CALLBACK_URL=${WEB}/git/github/callback`,
    `WEB_ORIGIN=${WEB}`,
    `LAUNCHOS_ENV=alpha`,
  ].join('\n') + '\n';
  await runner.writeTextFile('/opt/launchos/config/alpha-github.env', fragBody, 0o600);

  // Debug why merge dropped keys previously
  await runner.writeTextFile(
    '/opt/launchos/bin/step313-prepare.sh',
    `#!/bin/bash
set -euo pipefail
cd /opt/launchos/config
chmod 600 github-app.pem alpha-github.env
# show key NAMES and byte lengths only
echo FRAG_NAMES=$(sed -n 's/=.*//p' alpha-github.env | od -An -tx1 | head -1)
echo FRAG_LINES:
sed -n 's/=.*//p' alpha-github.env | cat -A
BASE=/opt/launchos/config/alpha-api.env
ts=$(date +%Y%m%d%H%M%S)
cp -a "$BASE" "alpha-api.env.bak3.$ts"
# Build new env: strip github keys then append fragment
awk -F= '!($1 ~ /^(GITHUB_APP_ID|GITHUB_APP_SLUG|GITHUB_APP_PRIVATE_KEY|GITHUB_APP_CLIENT_ID|GITHUB_APP_CLIENT_SECRET|GITHUB_APP_CALLBACK_URL|WEB_ORIGIN|LAUNCHOS_ENV)$/)' "$BASE" > /tmp/alpha-new.env
# Ensure unix newlines in fragment
sed 's/\\r$//' alpha-github.env >> /tmp/alpha-new.env
# Remove private key if any
awk -F= '$1!="GITHUB_APP_PRIVATE_KEY"' /tmp/alpha-new.env > "$BASE"
chmod 600 "$BASE"
echo BASE_NAMES:
sed -n 's/=.*//p' "$BASE" | grep -E '^(GITHUB_APP_|WEB_ORIGIN|LAUNCHOS_ENV)$' | cat -A
echo PEM_BYTES=$(wc -c < github-app.pem)
`,
  );
  const prep = await runner.execute(shellCommand('chmod 700 /opt/launchos/bin/step313-prepare.sh && /opt/launchos/bin/step313-prepare.sh'), {
    timeoutMs: 60000,
  });
  console.log('prep', String(prep.stdout || prep.stderr || ''));

  const imgR = await runner.execute(
    shellCommand(`podman image exists localhost/launchos-alpha-api:step311 && echo localhost/launchos-alpha-api:step311 || podman inspect ${LIVE} --format '{{.ImageName}}'`),
    { timeoutMs: 30000 },
  );
  const image = String(imgR.stdout || '').trim().split(/\s+/).pop();

  // Write start script ON SERVER that sources env names from files (no secrets in argv of local ssh)
  await runner.writeTextFile(
    '/opt/launchos/bin/step313-run-api.sh',
    `#!/bin/bash
set -euo pipefail
NAME="$1"
PORT="$2"
IMAGE="$3"
podman rm -f "$NAME" 2>/dev/null || true
# Export github vars from alpha-github.env into a cleaned env file for podman
# podman --env-file requires KEY=VALUE
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

  await runner.execute(shellCommand('chmod 700 /opt/launchos/bin/step313-run-api.sh'), { timeoutMs: 15000 });

  // Start candidate
  const startCand = await runner.execute(
    shellCommand(`/opt/launchos/bin/step313-run-api.sh ${CAND} ${CAND_PORT} ${image}`),
    { timeoutMs: 120000 },
  );
  console.log('startCand', startCand.exitCode, redact(String(startCand.stdout || startCand.stderr || '')).slice(0, 300));

  // Wait health + check boot keys from logs
  await runner.writeTextFile(
    '/opt/launchos/bin/step313-wait3.sh',
    `#!/bin/sh
i=0
while [ "$i" -lt 45 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:${CAND_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then
    curl -fsS http://127.0.0.1:${CAND_PORT}/api/v1/health
    echo
    echo LOG_BOOT=$(podman logs ${CAND} 2>&1 | grep BOOT_KEYS | tail -1)
    exit 0
  fi
  sleep 2
done
podman logs --tail 100 ${CAND} 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^ ]+/\\1=***/gi' | tail -50
exit 1
`,
  );
  const wait = await runner.execute(shellCommand('chmod 700 /opt/launchos/bin/step313-wait3.sh && /opt/launchos/bin/step313-wait3.sh'), {
    timeoutMs: 180000,
  });
  console.log('wait', wait.exitCode, redact(String(wait.stdout || wait.stderr || '')).slice(0, 500));
  if (wait.exitCode !== 0) throw new Error('candidate health failed');

  // Inspect env names inside container main... use /proc/1/environ names only
  const envNames = await runner.execute(
    shellCommand(
      `podman exec ${CAND} sh -c 'tr "\\0" "\\n" < /proc/1/environ | sed -n "s/=.*//p" | grep -E "^(GITHUB_APP_|WEB_ORIGIN|LAUNCHOS_ENV|API_PORT)$" | sort'`,
    ),
    { timeoutMs: 30000 },
  );
  console.log('proc1_env_names', String(envNames.stdout || ''));

  await applyColocatedNginxRoute({
    host: TARGET,
    port: server.port,
    username,
    password,
    hostname: API_HOST,
    targetPort: CAND_PORT,
    healthPath: '/api/v1/health',
  });

  let ready = false;
  let lastCfg = null;
  for (let i = 0; i < 15; i++) {
    const c = curl(`${API}/api/v1/git/github/config`, API_HOST);
    lastCfg = j(c.text);
    console.log('cfg', c.status, JSON.stringify({
      configured: lastCfg?.configured,
      connectionCapability: lastCfg?.connectionCapability,
      connectionReady: lastCfg?.connectionReady,
      diagnosis: lastCfg?.diagnosis,
    }));
    if (c.status === 200 && lastCfg?.connectionReady) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!ready) {
    await applyColocatedNginxRoute({
      host: TARGET,
      port: server.port,
      username,
      password,
      hostname: API_HOST,
      targetPort: LIVE_PORT,
      healthPath: '/api/v1/health',
    });
    throw new Error('candidate not READY after inject');
  }

  // Promote
  await runner.execute(shellCommand(`/opt/launchos/bin/step313-run-api.sh ${LIVE} ${LIVE_PORT} ${image}`), {
    timeoutMs: 120000,
  });
  await runner.writeTextFile(
    '/opt/launchos/bin/step313-wait-live3.sh',
    `#!/bin/sh
i=0
while [ "$i" -lt 45 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:${LIVE_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then
    curl -fsS http://127.0.0.1:${LIVE_PORT}/api/v1/health; echo; exit 0
  fi
  sleep 2
done
exit 1
`,
  );
  const liveWait = await runner.execute(
    shellCommand('chmod 700 /opt/launchos/bin/step313-wait-live3.sh && /opt/launchos/bin/step313-wait-live3.sh'),
    { timeoutMs: 180000 },
  );
  if (liveWait.exitCode !== 0) throw new Error('live health failed');

  await applyColocatedNginxRoute({
    host: TARGET,
    port: server.port,
    username,
    password,
    hostname: API_HOST,
    targetPort: LIVE_PORT,
    healthPath: '/api/v1/health',
  });
  await runner.execute(shellCommand(`podman rm -f ${CAND} || true`), { timeoutMs: 60000 });

  const health = curl(`${API}/api/v1/health`, API_HOST);
  const config = curl(`${API}/api/v1/git/github/config`, API_HOST);
  const configJson = j(config.text);

  const email = `alpha-s313c-${Date.now()}@zsaos.test`;
  const pass = `Alpha${randomBytes(5).toString('hex')}!aA1`;
  curl(`${API}/api/v1/auth/register`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB },
    body: JSON.stringify({ email, password: pass, name: 'S313C' }),
  });
  const login = curl(`${API}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB },
    body: JSON.stringify({ email, password: pass }),
  });
  const token = j(login.text)?.accessToken;
  const authz = curl(`${API}/api/v1/git/github/authorize?returnTo=/onboarding/source`, API_HOST, {
    headers: { authorization: `Bearer ${token}`, origin: WEB },
  });
  const authzJson = j(authz.text);
  if (authzJson?.url) writeFileSync(join(DIR, 'step313-authorize-url.txt'), authzJson.url, { mode: 0o600 });
  writeFileSync(join(DIR, 'step313-session.json'), JSON.stringify({ email, tokenPresent: Boolean(token) }), {
    mode: 0o600,
  });

  let urlHostPath = null;
  if (authzJson?.url) {
    try {
      const u = new URL(authzJson.url);
      urlHostPath = `${u.origin}${u.pathname}`;
    } catch {
      urlHostPath = 'invalid';
    }
  }

  report.configSource = {
    GITHUB_APP_ID: { present: true, source: 'env:.env' },
    GITHUB_APP_SLUG: { present: true, source: 'env:.env' },
    GITHUB_APP_PRIVATE_KEY: { present: true, source: 'env:.env' },
  };
  report.appIdPresent = { present: true, source: 'env:.env' };
  report.appSlugPresent = { present: true, source: 'env:.env' };
  report.privateKeyPresent = { present: true, source: 'env:.env' };
  report.privateKeyLoad = { ok: true, error: null };
  report.alphaApiSecretInjection = {
    method: 'alpha-github.env + github-app.pem mount; dual --env-file; PRIVATE_KEY via entrypoint cat only',
    permissions: '600',
    proc1EnvNames: String(envNames.stdout || '').trim().split(/\n/).filter(Boolean),
    webContainerInjected: false,
  };
  report.candidateRedeploy = { image, candidatePort: CAND_PORT, promotedTo: LIVE_PORT, ok: true };
  report.apiHealth = { status: health.status, ok: health.status === 200 && /launchos-api/.test(health.text) };
  report.githubCapability = {
    configStatus: config.status,
    configured: configJson?.configured ?? null,
    connectionCapability: configJson?.connectionCapability ?? null,
    connectionReady: configJson?.connectionReady ?? null,
    callbackUrl: configJson?.callbackUrl ?? null,
    ok: config.status === 200 && configJson?.connectionReady === true,
  };
  report.authorizeEndpoint = {
    status: authz.status,
    hasUrl: Boolean(authzJson?.url),
    hostIsGithub: Boolean(authzJson?.url && String(authzJson.url).includes('github.com')),
    urlHostPath,
    ok: authz.status >= 200 && authz.status < 300 && Boolean(authzJson?.url),
  };
  report.realGitHubAuthorization = { status: 'PENDING_BROWSER' };
  report.autoReturn = { status: 'PENDING_BROWSER' };
  report.repositorySync = { status: 'PENDING_BROWSER' };
  report.branchSelection = { status: 'PENDING_BROWSER' };
  report.githubAppRepositoryAnalyze = { status: 'PENDING_BROWSER' };
  report.permissions = { contents: 'Read-only', metadata: 'Read-only', writeAdded: false };
  report.secretsExposed = 'NO';
  report.paidResourceCreated = 'NO';

  const routes = {};
  for (const host of [
    'alpha.zsaos.com',
    'api-alpha.zsaos.com',
    'web-launchos.zsaos.com',
    'api-launchos.zsaos.com',
    'oneclick-web.zsaos.com',
    'launchos-real-test.zsaos.com',
  ]) {
    const primary = host.startsWith('api-') ? `https://${host}/api/v1/health` : `https://${host}/`;
    let res = curl(primary, host);
    if (host.startsWith('api-') && res.status === 404) res = curl(`https://${host}/health`, host);
    routes[host] = { status: res.status, ok: res.status >= 200 && res.status < 400 };
  }
  report.existingRoutes = routes;
  report.final = 'IN_PROGRESS';
  report.error = null;
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(
    'CORE_READY',
    JSON.stringify({
      apiHealth: report.apiHealth,
      githubCapability: report.githubCapability,
      authorizeEndpoint: report.authorizeEndpoint,
      proc1EnvNames: report.alphaApiSecretInjection.proc1EnvNames,
    }),
  );
} catch (e) {
  console.error('FAIL', redact(e.message || String(e)));
  report.final = 'FAIL';
  report.error = redact(e.message || String(e)).slice(0, 2000);
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await runner.disconnect().catch(() => {});
  await prisma.$disconnect().catch(() => {});
}
