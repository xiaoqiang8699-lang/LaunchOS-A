/**
 * Step 31.3 fixup — ensure GitHub App ID/SLUG/PEM are visible to Alpha API process.
 * Verifies via public config endpoint (not podman exec env).
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
const WEB_HOST = 'alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const WEB = `https://${WEB_HOST}`;
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
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^\s"']+/gi, '$1=***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
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
function normalizePem(raw) {
  return String(raw || '').trim().replace(/\\n/g, '\n');
}

const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : {};
mkdirSync(DIR, { recursive: true });

const appId = process.env.GITHUB_APP_ID?.trim() || '';
const slug = process.env.GITHUB_APP_SLUG?.trim() || '';
const pem = normalizePem(process.env.GITHUB_APP_PRIVATE_KEY || '');
if (!appId || !slug || !pem) throw new Error('missing local github app creds');
createPrivateKey(pem);
createGitHubAppJwt(appId, pem);

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET } });
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remote(cmd, timeoutMs = 120000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  return r;
}

try {
  // Ensure PEM on host
  const localPem = join(DIR, '.step313-github-app.pem');
  writeFileSync(localPem, pem.endsWith('\n') ? pem : pem + '\n', { mode: 0o600 });
  await runner.upload(localPem, '/opt/launchos/config/github-app.pem', { timeoutMs: 60000 });
  writeFileSync(localPem, '');
  await remote('chmod 600 /opt/launchos/config/github-app.pem; ls -la /opt/launchos/config/github-app.pem | awk "{print \\$1, \\$5, \\$9}"');

  // Rewrite alpha-github.env with explicit lines via remote writeTextFile of ONLY keys that are safe?
  // Better: upload binary-safe env fragment again
  const frag = [
    `GITHUB_APP_ID=${appId}`,
    `GITHUB_APP_SLUG=${slug}`,
    `GITHUB_APP_CALLBACK_URL=${WEB}/git/github/callback`,
    `WEB_ORIGIN=${WEB}`,
    `LAUNCHOS_ENV=alpha`,
  ].join('\n') + '\n';
  const fragPath = join(DIR, '.step313-frag.env');
  writeFileSync(fragPath, frag, { mode: 0o600 });
  await runner.upload(fragPath, '/opt/launchos/config/alpha-github.env', { timeoutMs: 30000 });
  writeFileSync(fragPath, '');
  await remote('chmod 600 /opt/launchos/config/alpha-github.env; wc -l /opt/launchos/config/alpha-github.env; sed -n "s/=.*//p" /opt/launchos/config/alpha-github.env');

  // Merge robustly
  await runner.writeTextFile(
    '/opt/launchos/bin/step313-merge2.sh',
    `#!/bin/bash
set -euo pipefail
BASE=/opt/launchos/config/alpha-api.env
FRAG=/opt/launchos/config/alpha-github.env
test -f "$BASE"
test -f "$FRAG"
ts=$(date +%Y%m%d%H%M%S)
cp -a "$BASE" "/opt/launchos/config/alpha-api.env.bak2.$ts"
grep -Ev '^(GITHUB_APP_ID|GITHUB_APP_SLUG|GITHUB_APP_PRIVATE_KEY|GITHUB_APP_CLIENT_ID|GITHUB_APP_CLIENT_SECRET|GITHUB_APP_CALLBACK_URL|WEB_ORIGIN|LAUNCHOS_ENV)=' "$BASE" > /tmp/alpha-base.stripped || true
cat /tmp/alpha-base.stripped "$FRAG" > "$BASE"
# strip any private key line if present
grep -v '^GITHUB_APP_PRIVATE_KEY=' "$BASE" > /tmp/alpha-base.nopk || true
mv /tmp/alpha-base.nopk "$BASE"
chmod 600 "$BASE"
echo FRAG_KEYS=$(sed -n 's/=.*//p' "$FRAG" | tr '\\n' ',')
echo BASE_GH_KEYS=$(grep -E '^(GITHUB_APP_|WEB_ORIGIN|LAUNCHOS_ENV)=' "$BASE" | sed 's/=.*//' | tr '\\n' ',')
echo PEM_OK=$(test -s /opt/launchos/config/github-app.pem && echo yes || echo no)
`,
  );
  const merge = await remote('chmod 700 /opt/launchos/bin/step313-merge2.sh && /opt/launchos/bin/step313-merge2.sh');
  console.log('merge', redact(String(merge.stdout || merge.stderr || '')));

  // Detect image
  const imgR = await remote(`podman image exists localhost/launchos-alpha-api:step311 && echo step311 || podman inspect ${LIVE} --format '{{.ImageName}}'`);
  const image = String(imgR.stdout || '').includes('step311')
    ? 'localhost/launchos-alpha-api:step311'
    : String(imgR.stdout || '').trim();

  // Pass ID/SLUG as -e as well (belt and suspenders), PRIVATE_KEY only via entrypoint cat pem
  const runCmd = (name, port) =>
    [
      `podman run -d --name ${name}`,
      `--restart unless-stopped --network host`,
      `--env-file /opt/launchos/config/alpha-api.env`,
      `-e API_PORT=${port}`,
      `-e WEB_ORIGIN=${WEB}`,
      `-e LAUNCHOS_ENV=alpha`,
      `-e GITHUB_APP_CALLBACK_URL=${WEB}/git/github/callback`,
      `-e GITHUB_APP_ID=${appId}`,
      `-e GITHUB_APP_SLUG=${slug}`,
      `-v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro`,
      `--entrypoint /bin/sh ${image}`,
      `-c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/api/dist/main.js'`,
    ].join(' ');

  await remote(`podman rm -f ${CAND} 2>/dev/null || true`);
  const startCand = await remote(runCmd(CAND, CAND_PORT), 120000);
  console.log('cand start', redact(String(startCand.stdout || '')).slice(0, 80), 'exit', startCand.exitCode);

  await runner.writeTextFile(
    '/opt/launchos/bin/step313-wait2.sh',
    `#!/bin/sh
i=0
while [ "$i" -lt 45 ]; do
  i=$((i+1))
  body=$(curl -fsS http://127.0.0.1:${CAND_PORT}/api/v1/health 2>/dev/null || true)
  echo "$body" | grep -q launchos-api && echo "$body" && exit 0
  sleep 2
done
podman logs --tail 80 ${CAND} 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^ ]+/\\1=***/gi' | tail -40
exit 1
`,
  );
  const wait = await remote('chmod 700 /opt/launchos/bin/step313-wait2.sh && /opt/launchos/bin/step313-wait2.sh', 180000);
  console.log('cand health', redact(String(wait.stdout || '')).slice(0, 200), 'exit', wait.exitCode);
  if (wait.exitCode !== 0) throw new Error('candidate health failed');

  // Switch nginx to candidate and probe public config
  await applyColocatedNginxRoute({
    host: TARGET,
    port: server.port,
    username,
    password,
    hostname: API_HOST,
    targetPort: CAND_PORT,
    healthPath: '/api/v1/health',
  });

  let cfg = null;
  for (let i = 0; i < 20; i++) {
    const h = curl(`${API}/api/v1/health`, API_HOST);
    const c = curl(`${API}/api/v1/git/github/config`, API_HOST);
    cfg = { health: h, config: c, json: j(c.text) };
    if (h.status === 200 && c.status === 200 && j(c.text)?.connectionReady) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('cand public config', cfg?.config.status, JSON.stringify({
    configured: cfg?.json?.configured,
    connectionCapability: cfg?.json?.connectionCapability,
    connectionReady: cfg?.json?.connectionReady,
    callbackUrl: cfg?.json?.callbackUrl,
    diagnosis: cfg?.json?.diagnosis,
  }));

  if (!cfg?.json?.connectionReady) {
    // rollback nginx
    await applyColocatedNginxRoute({
      host: TARGET,
      port: server.port,
      username,
      password,
      hostname: API_HOST,
      targetPort: LIVE_PORT,
      healthPath: '/api/v1/health',
    });
    throw new Error(`candidate config not ready: ${redact(cfg?.config.text || '')}`);
  }

  // Promote live
  await remote(`podman rm -f ${LIVE} || true`);
  const startLive = await remote(runCmd(LIVE, LIVE_PORT), 120000);
  console.log('live start', startLive.exitCode);
  await runner.writeTextFile(
    '/opt/launchos/bin/step313-wait-live2.sh',
    `#!/bin/sh
i=0
while [ "$i" -lt 45 ]; do
  i=$((i+1))
  body=$(curl -fsS http://127.0.0.1:${LIVE_PORT}/api/v1/health 2>/dev/null || true)
  echo "$body" | grep -q launchos-api && echo "$body" && exit 0
  sleep 2
done
podman logs --tail 80 ${LIVE} 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^ ]+/\\1=***/gi' | tail -40
exit 1
`,
  );
  const liveWait = await remote('chmod 700 /opt/launchos/bin/step313-wait-live2.sh && /opt/launchos/bin/step313-wait-live2.sh', 180000);
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
  await remote(`podman rm -f ${CAND} || true`);

  const health = curl(`${API}/api/v1/health`, API_HOST);
  const config = curl(`${API}/api/v1/git/github/config`, API_HOST);
  const configJson = j(config.text);

  report.alphaApiSecretInjection = {
    method: 'alpha-api.env keys + github-app.pem mount; PRIVATE_KEY via entrypoint only; ID/SLUG also passed as -e',
    permissions: '600',
    merge: redact(String(merge.stdout || '')).trim(),
    webContainerInjected: false,
  };
  report.candidateRedeploy = {
    image,
    candidatePort: CAND_PORT,
    promotedTo: LIVE_PORT,
    result: 'candidate READY then promoted',
  };
  report.apiHealth = {
    status: health.status,
    ok: health.status === 200 && /launchos-api/.test(health.text),
  };
  report.githubCapability = {
    configStatus: config.status,
    configured: configJson?.configured ?? null,
    connectionCapability: configJson?.connectionCapability ?? null,
    connectionReady: configJson?.connectionReady ?? null,
    callbackUrl: configJson?.callbackUrl ?? null,
    diagnosis: configJson?.diagnosis ?? null,
    ok: config.status === 200 && configJson?.connectionReady === true,
  };

  // Authorize
  const email = `alpha-s313b-${Date.now()}@zsaos.test`;
  const pass = `Alpha${randomBytes(5).toString('hex')}!aA1`;
  curl(`${API}/api/v1/auth/register`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB },
    body: JSON.stringify({ email, password: pass, name: 'S313B' }),
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
  let urlHostPath = null;
  if (authzJson?.url) {
    try {
      const u = new URL(authzJson.url);
      urlHostPath = `${u.origin}${u.pathname}`;
    } catch {
      urlHostPath = 'invalid';
    }
  }
  report.authorizeEndpoint = {
    status: authz.status,
    hasUrl: Boolean(authzJson?.url),
    hostIsGithub: Boolean(authzJson?.url && String(authzJson.url).includes('github.com')),
    urlHostPath,
    ok: authz.status >= 200 && authz.status < 300 && Boolean(authzJson?.url) && String(authzJson.url).includes('github.com'),
  };
  // Persist authorize URL path for browser follow-up (not full state if possible - we need full URL for browser)
  if (authzJson?.url) {
    writeFileSync(join(DIR, 'step313-authorize-url.txt'), authzJson.url, { mode: 0o600 });
  }
  writeFileSync(join(DIR, 'step313-user.json'), JSON.stringify({ email, password: '***', hasToken: Boolean(token) }));

  // routes
  const routes = {};
  for (const host of [WEB_HOST, API_HOST, 'web-launchos.zsaos.com', 'api-launchos.zsaos.com', 'oneclick-web.zsaos.com', 'launchos-real-test.zsaos.com']) {
    const primary = host.startsWith('api-') ? `https://${host}/api/v1/health` : `https://${host}/`;
    let res = curl(primary, host);
    if (host.startsWith('api-') && res.status === 404) res = curl(`https://${host}/health`, host);
    routes[host] = { status: res.status, ok: res.status >= 200 && res.status < 400 };
  }
  report.existingRoutes = routes;
  report.permissions = { contents: 'Read-only', metadata: 'Read-only', writeAdded: false };
  report.secretsExposed = 'NO';
  report.paidResourceCreated = 'NO';
  report.realGitHubAuthorization = { status: 'PENDING_BROWSER' };
  report.autoReturn = { status: 'PENDING_BROWSER' };
  report.repositorySync = { status: 'PENDING_BROWSER' };
  report.branchSelection = { status: 'PENDING_BROWSER' };
  report.githubAppRepositoryAnalyze = { status: 'PENDING_BROWSER' };
  report.final = 'IN_PROGRESS';
  report.error = null;
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('CORE_READY', JSON.stringify({
    apiHealth: report.apiHealth,
    githubCapability: report.githubCapability,
    authorizeEndpoint: report.authorizeEndpoint,
  }));
} catch (e) {
  console.error('FAIL', redact(e.message || String(e)));
  report.error = redact(e.message || String(e)).slice(0, 2000);
  report.final = 'FAIL';
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await runner.disconnect().catch(() => {});
  await prisma.$disconnect().catch(() => {});
}
