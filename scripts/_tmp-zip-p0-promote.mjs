/**
 * ZIP Source Upload P0 — promote API+WEB to Alpha + size smoke.
 * node scripts/_tmp-zip-p0-promote.mjs --confirm-zip-p0
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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
if (!process.argv.includes('--confirm-zip-p0')) {
  console.error('pass --confirm-zip-p0');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand, ZIP_SOURCE_MAX_BYTES } =
  requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const API_TAG = 'launchos-alpha-api:zip1200';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_TAG = 'launchos-alpha-web:zip1200';
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_WEB = 'launchos-alpha-web';
const CANDIDATE_WEB = 'launchos-alpha-web-zip1200-cand';
const WEB_PORT = 39082;
const CANDIDATE_PORT = 39099;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const skipBuild = process.argv.includes('--skip-build');
const skipApi = process.argv.includes('--skip-api');
const skipWeb = process.argv.includes('--skip-web');

const adminAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'admin-auth.json'), 'utf8'));
const userAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, '1002-auth.json'), 'utf8'));
const ADMIN_EMAIL = adminAuth.email;
const ADMIN_PASSWORD = adminAuth.password;
const USER_EMAIL = userAuth.email || '1002@qq.com';
const USER_PASSWORD = userAuth.password;

function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, formFile = null, maxTime = '90', useResolve = true } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  if (useResolve) args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (formFile) {
    args.push('-F', `file=@${formFile};type=application/zip`);
  } else if (body != null) {
    args.push('-H', 'content-type: application/json', '--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}
function parse(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}
function makeZip(path, approxBytes) {
  const { zipSync } = requireApi('fflate');
  const enc = new TextEncoder();
  const overhead = 8192;
  const pad = Math.max(64, approxBytes - overhead);
  const random = new Uint8Array(pad);
  for (let i = 0; i < pad; i += 1) random[i] = (i * 17 + 31) % 251;
  const buf = zipSync(
    {
      'package.json': enc.encode(JSON.stringify({ name: `zip-smoke-${randomUUID().slice(0, 8)}` })),
      'app/index.js': enc.encode("console.log('ok')\n"),
      'data/pad.bin': random,
    },
    { level: 0 },
  );
  writeFileSync(path, buf);
  return statSync(path).size;
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('platform server missing');
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label, timeoutMs = 180000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

if (!skipBuild && !skipApi) {
  console.log('[1a] build', API_TAG);
  const b = local('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    'deploy/alpha/Dockerfile.api',
    '-t',
    API_TAG,
    '.',
  ]);
  writeFileSync(join(ARTIFACT_DIR, 'zip1200-api-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
  if (b.status !== 0) throw new Error('api build failed');
}

if (!skipBuild && !skipWeb) {
  console.log('[1b] build', WEB_TAG);
  const b = local('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    'deploy/alpha/Dockerfile.web',
    '-t',
    WEB_TAG,
    '--build-arg',
    'NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com',
    '.',
  ]);
  writeFileSync(join(ARTIFACT_DIR, 'zip1200-web-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
  if (b.status !== 0) throw new Error('web build failed');
}

if (!skipWeb) {
  const markers = local('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    WEB_TAG,
    '-c',
    `grep -Rsl '压缩包过大\\|文件大小\\|正在上传代码\\|最大 1200 MB\\|SOURCE_ARCHIVE' /app 2>/dev/null | head -20; echo MARK=$(grep -Rsl '压缩包过大\\|正在上传代码' /app 2>/dev/null | wc -l)`,
  ]);
  console.log(String(markers.stdout || '').trim().slice(-1500));
  if (!/MARK=[1-9]/.test(String(markers.stdout || ''))) throw new Error('ZIP UX markers missing in web image');
}

if (!skipApi) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-api-zip1200.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, API_TAG]).status !== 0) throw new Error('api save failed');
  console.log('[2a] upload api', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-api-zip1200.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-api-zip1200.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-zip1200.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
    'api-load',
    600000,
  );
  await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'run-api', 120000);
  let apiReady = false;
  for (let i = 0; i < 60; i++) {
    const probe = await runner.execute(
      shellCommand('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health'),
      { timeoutMs: 15000 },
    );
    if (probe.exitCode === 0) {
      apiReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!apiReady) await remoteOk('/opt/launchos/tmp/m5-wait-api.sh', 'wait-api', 120000);
}

if (!skipWeb) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-web-zip1200.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, WEB_TAG]).status !== 0) throw new Error('web save failed');
  console.log('[2b] upload web', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-web-zip1200.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-web-zip1200.tar && rm -f /opt/launchos/tmp/launchos-alpha-web-zip1200.tar && (podman tag docker.io/library/${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || podman tag ${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || true)`,
    'web-load',
    600000,
  );
  await runner.writeTextFile(
    '/opt/launchos/bin/zip1200-run-web.sh',
    `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"; HOSTPORT="$3"
podman rm -f "$NAME" 2>/dev/null || true
sleep 1
EXTRA=()
if [[ -f /opt/launchos/config/alpha-web.env ]]; then EXTRA+=(--env-file /opt/launchos/config/alpha-web.env); fi
podman run -d --name "$NAME" --restart unless-stopped -p 127.0.0.1:\${HOSTPORT}:3000 \\
  -e PORT=3000 -e HOSTNAME=0.0.0.0 -e NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com "\${EXTRA[@]}" "$IMAGE"
echo STARTED
`,
  );
  await remoteOk('chmod 700 /opt/launchos/bin/zip1200-run-web.sh', 'chmod');
  console.log('[3] candidate web');
  await remoteOk(`/opt/launchos/bin/zip1200-run-web.sh ${CANDIDATE_WEB} ${WEB_REMOTE} ${CANDIDATE_PORT}`, 'cand', 120000);
  await new Promise((r) => setTimeout(r, 4000));
  const cand = await remoteOk(
    `curl -sS -o /dev/null -w 'code=%{http_code}\\n' --max-time 15 http://127.0.0.1:${CANDIDATE_PORT}/login`,
    'cand-http',
  );
  if (!/code=200/.test(cand.stdout)) throw new Error('candidate unhealthy');
  console.log('[4] switch live web');
  await remoteOk(`/opt/launchos/bin/zip1200-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'live', 120000);
  await applyColocatedNginxRoute({
    host: TARGET_HOST,
    port: server.port,
    username,
    password,
    hostname: 'alpha.zsaos.com',
    healthPath: '/',
    targetPort: WEB_PORT,
  });
  await remoteOk(`podman rm -f ${CANDIDATE_WEB} 2>/dev/null || true`, 'rm-cand');
}

await new Promise((r) => setTimeout(r, 5000));

const nginxBody = await runner.execute(
  shellCommand(`grep -nE 'api-alpha|client_max_body_size' /opt/launchos/gateway/active/launchos-routes.conf | head -n 40`),
  { timeoutMs: 15000 },
);
console.log('NGINX_BODY', nginxBody.stdout);

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
const adminToken = parse(adminLogin.text).accessToken;
if (!adminToken) throw new Error('admin login failed: ' + adminLogin.text.slice(0, 300));
const adminHdr = { authorization: `Bearer ${adminToken}` };

const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
});
const userToken = parse(userLogin.text).accessToken;
if (!userToken) throw new Error('user login failed: ' + userLogin.text.slice(0, 300));
const userHdr = { authorization: `Bearer ${userToken}` };

const usage = curl('https://api-alpha.zsaos.com/api/v1/account/usage', 'api-alpha.zsaos.com', { headers: userHdr });
const usageBody = parse(usage.text);
const projectsProbe = curl('https://api-alpha.zsaos.com/api/v1/projects', 'api-alpha.zsaos.com', { headers: userHdr });
const projectsList = parse(projectsProbe.text);
const workspaceId = Array.isArray(projectsList) && projectsList[0]?.workspaceId
  ? projectsList[0].workspaceId
  : null;
console.log('USAGE', usage.status, JSON.stringify({ plan: usageBody.plan, projects: usageBody.usage?.projects, workspaceId }).slice(0, 300));

// Raise project cap for ZIP matrix (temporary override; no plan catalog change).
if (workspaceId) {
  const ov = curl(`https://api-alpha.zsaos.com/api/v1/admin/workspaces/${workspaceId}/entitlement-override`, 'api-alpha.zsaos.com', {
    method: 'POST',
    headers: adminHdr,
    body: JSON.stringify({
      entitlements: { maxProjects: 50 },
      reason: 'ZIP_SOURCE_UPLOAD_P0_SMOKE',
    }),
  });
  console.log('OVERRIDE', ov.status, ov.text.slice(0, 200));
} else {
  console.log('OVERRIDE_SKIP no workspaceId from projects list');
}

const tmp = join(ARTIFACT_DIR, 'zip-p0-smoke');
mkdirSync(tmp, { recursive: true });
const smokeCases = [
  { label: '1MB', bytes: 1 * 1024 * 1024, expect: 'PASS' },
  { label: '20MB', bytes: 20 * 1024 * 1024, expect: 'PASS' },
  { label: '50MB', bytes: 50 * 1024 * 1024, expect: 'PASS' },
  { label: '100MB', bytes: 100 * 1024 * 1024, expect: 'PASS' },
  { label: '~195MB', bytes: 195 * 1024 * 1024, expect: 'PASS' },
  { label: '>1200MB', bytes: ZIP_SOURCE_MAX_BYTES + 1024 * 1024, expect: 'REJECT_413' },
];
const smokeResults = [];
for (const c of smokeCases) {
  const file = join(tmp, `${c.label.replace(/[~.>]/g, '')}-${randomUUID().slice(0, 8)}.zip`);
  const size = makeZip(file, c.bytes);
  console.log('SMOKE', c.label, size);
  const res = curl('https://api-alpha.zsaos.com/api/v1/projects/source/zip', 'api-alpha.zsaos.com', {
    method: 'POST',
    headers: userHdr,
    formFile: file,
    maxTime: '600',
  });
  const body = parse(res.text);
  const ok =
    c.expect === 'PASS'
      ? res.status >= 200 && res.status < 300 && Boolean(body.id)
      : res.status === 413 && body.code === 'SOURCE_ARCHIVE_TOO_LARGE';
  smokeResults.push({ label: c.label, size, status: res.status, code: body.code, projectId: body.id || null, ok, message: body.message });
  console.log(smokeResults[smokeResults.length - 1]);
  try {
    unlinkSync(file);
  } catch {}
}

const projects = curl('https://api-alpha.zsaos.com/api/v1/projects', 'api-alpha.zsaos.com', { headers: userHdr });
const webHome = curl('https://alpha.zsaos.com/', 'alpha.zsaos.com', { useResolve: false });
const webCreate = curl('https://alpha.zsaos.com/projects/new', 'alpha.zsaos.com', { useResolve: false });

const report = {
  ZIP_SOURCE_MAX_BYTES,
  previousLimitMb: 200,
  newLimitMb: 1200,
  rootCause: 'Nest Multer / ZIP_INTAKE_LIMITS.maxZipBytes=80MB (LIMIT_FILE_SIZE → "File too large")',
  nginxBodySnippet: String(nginxBody.stdout || '').slice(0, 1500),
  smokeResults,
  smokePass: smokeResults.every((r) => r.ok),
  projectsStatus: projects.status,
  webHome: webHome.status,
  webCreate: webCreate.status,
  images: { api: API_TAG, web: WEB_TAG, worker: 'unchanged' },
};
writeFileSync(join(ARTIFACT_DIR, 'zip-p0-alpha-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await runner.disconnect();
await prisma.$disconnect();
if (!report.smokePass || report.webHome !== 200) process.exit(1);
console.log('ZIP_SOURCE_UPLOAD_READY=true');
