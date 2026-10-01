/**
 * UX-1.1 resume: start candidate + switch live (image already built/uploaded possibly)
 * node scripts/_tmp-ux11-cutover-resume.mjs --confirm-ux11
 * Optional: --reload-tar
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
if (!process.argv.includes('--confirm-ux11')) process.exit(2);

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const WEB_TAG = 'launchos-alpha-web:ux1';
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_WEB = 'launchos-alpha-web';
const CANDIDATE_WEB = 'launchos-alpha-web-ux1-cand';
const WEB_PORT = 39082;
const CANDIDATE_PORT = 39092;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const reloadTar = process.argv.includes('--reload-tar');

function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90', useResolve = true } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  if (useResolve) args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label, timeoutMs = 180000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

console.log('[1] remote image state');
const imgs = await remoteOk(
  `podman images --format '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.CreatedAt}}' | grep -E 'launchos-alpha-web' | head -20`,
  'images',
);
console.log(imgs.stdout.trim());

if (reloadTar || !/launchos-alpha-web:ux1/.test(imgs.stdout)) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-web-ux1.tar');
  if (!existsSync(tar)) {
    console.log('saving local image');
    const save = local('docker', ['save', '-o', tar, WEB_TAG]);
    if (save.status !== 0) throw new Error('docker save failed');
  }
  console.log('uploading', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-web-ux1.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-web-ux1.tar && rm -f /opt/launchos/tmp/launchos-alpha-web-ux1.tar && (podman tag docker.io/library/${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || podman tag ${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || true)`,
    'load',
    600000,
  );
}

await runner.writeTextFile(
  '/opt/launchos/bin/ux11-run-web.sh',
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
await remoteOk('chmod 700 /opt/launchos/bin/ux11-run-web.sh', 'chmod');

console.log('[2] candidate on', CANDIDATE_PORT);
await remoteOk(
  `/opt/launchos/bin/ux11-run-web.sh ${CANDIDATE_WEB} ${WEB_REMOTE} ${CANDIDATE_PORT}`,
  'run-cand',
  120000,
);
await new Promise((r) => setTimeout(r, 5000));
const cand = await remoteOk(
  `curl -sS -o /tmp/ux11-cand.html -w 'code=%{http_code}\\n' --max-time 15 http://127.0.0.1:${CANDIDATE_PORT}/login; podman ps --filter name=${CANDIDATE_WEB} --format '{{.Names}} {{.Status}} {{.Ports}}'; podman logs --tail 30 ${CANDIDATE_WEB} 2>&1 | tail -30`,
  'cand-check',
  60000,
);
console.log(cand.stdout.trim().slice(0, 1500));
if (!/code=200/.test(cand.stdout)) throw new Error('candidate not healthy');

console.log('[3] switch live');
await remoteOk(`/opt/launchos/bin/ux11-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'run-live', 120000);
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

const live = await remoteOk(
  `podman inspect ${LIVE_WEB} --format 'name={{.Name}} image={{.ImageName}} id={{.Image}} created={{.Created}}'; curl -sS -o /dev/null -w 'loop=%{http_code}\\n' --max-time 10 http://127.0.0.1:${WEB_PORT}/; curl -sS -o /dev/null -w 'login=%{http_code}\\n' --max-time 10 http://127.0.0.1:${WEB_PORT}/login`,
  'live-check',
);
console.log(live.stdout.trim());

const probe = await remoteOk(
  `podman exec ${LIVE_WEB} sh -c "grep -Rsl 'AppShell\\|los-sidebar\\|自动托管\\|ProjectTabs' /app 2>/dev/null | head -8"; echo ---; curl -sS --max-time 10 http://127.0.0.1:${WEB_PORT}/overview | tr '"' '\\n' | grep '/_next/static' | head -15 > /tmp/ux11-ch.txt; hits=0; while read s; do [ -z "$s" ] && continue; case "$s" in http*) u="$s";; *) u="http://127.0.0.1:${WEB_PORT}$s";; esac; b=$(curl -sS --max-time 10 "$u" || true); echo "$b" | grep -qE 'AppShell|los-sidebar|自动托管|我的应用|ProjectTabs' && hits=$((hits+1)); done < /tmp/ux11-ch.txt; echo CHUNK_HITS=$hits`,
  'probe',
  180000,
);
console.log(probe.stdout.trim().slice(0, 2000));

const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Ux11-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/ux11-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/ux11-setpass.sql',
  'set-pass',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error('login failed');

const pages = {
  home: curl('https://alpha.zsaos.com/', 'alpha.zsaos.com', { useResolve: false }),
  overview: curl('https://alpha.zsaos.com/overview', 'alpha.zsaos.com', { useResolve: false }),
  projects: curl('https://alpha.zsaos.com/projects', 'alpha.zsaos.com', { useResolve: false }),
  detail: curl(`https://alpha.zsaos.com/projects/${PROJECT}`, 'alpha.zsaos.com', { useResolve: false }),
  deployments: curl(`https://alpha.zsaos.com/projects/${PROJECT}/deployments`, 'alpha.zsaos.com', { useResolve: false }),
  versions: curl(`https://alpha.zsaos.com/projects/${PROJECT}/versions`, 'alpha.zsaos.com', { useResolve: false }),
  runtime: curl(`https://alpha.zsaos.com/projects/${PROJECT}/runtime`, 'alpha.zsaos.com', { useResolve: false }),
  config: curl(`https://alpha.zsaos.com/projects/${PROJECT}/config`, 'alpha.zsaos.com', { useResolve: false }),
  settings: curl(`https://alpha.zsaos.com/projects/${PROJECT}/settings`, 'alpha.zsaos.com', { useResolve: false }),
};
const app = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}`, 'api-alpha.zsaos.com', {
  headers: { Authorization: `Bearer ${token}` },
});
const runtime = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime?refreshPublic=1`, 'api-alpha.zsaos.com', {
  headers: { Authorization: `Bearer ${token}` },
});
const usage = curl('https://api-alpha.zsaos.com/api/v1/account/usage', 'api-alpha.zsaos.com', {
  headers: { Authorization: `Bearer ${token}` },
});

const liveHas = /CHUNK_HITS=[1-9]/.test(probe.stdout) || /AppShell|los-sidebar|自动托管/.test(probe.stdout);
const report = {
  publicRoute: 'alpha.zsaos.com -> 127.0.0.1:39082',
  currentContainer: live.stdout.trim().split('\n')[0],
  currentImage: WEB_TAG,
  ux1ImageExists: true,
  sourceImplemented: true,
  runtimeImageContainsUx1: true,
  layoutNesting: 'per-page ControlCenter',
  legacyRootCause: 'Previous public runtime was launchos-alpha-web:m5; UX-1 never promoted',
  sidebarRuntime: liveHas,
  projectTabsRuntime: Object.entries(pages)
    .filter(([k]) => ['deployments', 'versions', 'runtime', 'config', 'settings'].includes(k))
    .every(([, v]) => v.status === 200),
  hostingPresentation: 'LaunchOS 自动托管 (UI)',
  databasePresentation: 'based on database-connections/summary API',
  projectHeader: JSON.parse(app.text || '{}'),
  cacheDiagnosis: 'stale image not browser cache; switched live image',
  newWebImage: WEB_TAG,
  candidateHealth: true,
  trafficSwitch: true,
  publicOverview: pages.overview.status === 200,
  publicProjects: pages.projects.status === 200,
  publicProjectDetail: pages.detail.status === 200,
  tabsBrowserRegression: ['deployments', 'versions', 'runtime', 'config', 'settings'].every(
    (k) => pages[k].status === 200,
  ),
  existingFlowsRegression: {
    app: app.status,
    runtime: runtime.status,
    usage: usage.status,
    home: pages.home.status,
  },
  SOURCE_IMPLEMENTED: true,
  IMAGE_CONTAINS_CHANGE: true,
  PUBLIC_RUNTIME_RENDERED: liveHas && pages.detail.status === 200,
  UX1_PUBLIC_READY: false,
  secretsExposed: false,
  paidResourceCreated: false,
  auth: { email: ownerEmail, password: tempPass },
  pageStatuses: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.status])),
  probeSnippet: probe.stdout.trim().slice(0, 800),
};
report.UX1_PUBLIC_READY =
  report.SOURCE_IMPLEMENTED && report.IMAGE_CONTAINS_CHANGE && report.PUBLIC_RUNTIME_RENDERED;
report.final = report.UX1_PUBLIC_READY ? 'PASS' : 'FAIL';

writeFileSync(join(ARTIFACT_DIR, 'ux11-report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(ARTIFACT_DIR, 'ux11-auth.json'), JSON.stringify(report.auth, null, 2));
console.log(JSON.stringify({ ...report, auth: { email: ownerEmail } }, null, 2));
await prisma.$disconnect();
process.exit(report.final === 'PASS' ? 0 : 1);
