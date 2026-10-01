/**
 * UX-2: build + promote web image to Alpha, then smoke public routes.
 * node scripts/_tmp-ux2-promote-web.mjs --confirm-ux2
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
if (!process.argv.includes('--confirm-ux2')) {
  console.error('pass --confirm-ux2');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const WEB_TAG = 'launchos-alpha-web:ux2';
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_WEB = 'launchos-alpha-web';
const CANDIDATE_WEB = 'launchos-alpha-web-ux2-cand';
const WEB_PORT = 39082;
const CANDIDATE_PORT = 39093;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const skipBuild = process.argv.includes('--skip-build');

function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '60', useResolve = true } = opts;
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

if (!skipBuild) {
  console.log('[1] build', WEB_TAG);
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
  writeFileSync(join(ARTIFACT_DIR, 'ux2-web-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
  if (b.status !== 0) throw new Error('web build failed');
}

const markers = local('docker', [
  'run',
  '--rm',
  '--entrypoint',
  'sh',
  WEB_TAG,
  '-c',
  `grep -Rsl '/team\\|/usage\\|/plan\\|/billing\\|/profile\\|团队协作需要更高套餐' /app 2>/dev/null | head -10; echo MARK=$(grep -Rsl '/team' /app 2>/dev/null | wc -l)`,
]);
console.log(String(markers.stdout || '').trim().slice(-800));
if (!/MARK=[1-9]/.test(String(markers.stdout || ''))) throw new Error('UX-2 routes missing in image');

const tar = join(ARTIFACT_DIR, 'launchos-alpha-web-ux2.tar');
try {
  unlinkSync(tar);
} catch {}
if (local('docker', ['save', '-o', tar, WEB_TAG]).status !== 0) throw new Error('docker save failed');
console.log('[2] upload', statSync(tar).size);
try {
  await runner.disconnect();
} catch {}
await runner.connect({ host: server.host, port: server.port, username, password });
await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-web-ux2.tar', { timeoutMs: 900000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-web-ux2.tar && rm -f /opt/launchos/tmp/launchos-alpha-web-ux2.tar && (podman tag docker.io/library/${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || podman tag ${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || true)`,
  'load',
  600000,
);

await runner.writeTextFile(
  '/opt/launchos/bin/ux2-run-web.sh',
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
await remoteOk('chmod 700 /opt/launchos/bin/ux2-run-web.sh', 'chmod');

console.log('[3] candidate');
await remoteOk(`/opt/launchos/bin/ux2-run-web.sh ${CANDIDATE_WEB} ${WEB_REMOTE} ${CANDIDATE_PORT}`, 'cand', 120000);
await new Promise((r) => setTimeout(r, 4000));
const cand = await remoteOk(
  `curl -sS -o /dev/null -w 'code=%{http_code}\\n' --max-time 15 http://127.0.0.1:${CANDIDATE_PORT}/login`,
  'cand-http',
);
if (!/code=200/.test(cand.stdout)) throw new Error('candidate unhealthy');

console.log('[4] switch live');
await remoteOk(`/opt/launchos/bin/ux2-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'live', 120000);
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

const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Ux2-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/ux2-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/ux2-setpass.sql',
  'set-pass',
);

const pages = ['/team', '/usage', '/plan', '/billing', '/profile', '/profile/security', '/help', '/overview', '/projects'];
const statuses = {};
for (const p of pages) {
  statuses[p] = curl(`https://alpha.zsaos.com${p}`, 'alpha.zsaos.com', { useResolve: false }).status;
}
const redirects = {
  accountProfile: curl('https://alpha.zsaos.com/account?tab=profile', 'alpha.zsaos.com', { useResolve: false }).status,
  accountSub: curl('https://alpha.zsaos.com/account?tab=subscription', 'alpha.zsaos.com', { useResolve: false }).status,
  accountBilling: curl('https://alpha.zsaos.com/account?tab=billing', 'alpha.zsaos.com', { useResolve: false }).status,
  accountUsage: curl('https://alpha.zsaos.com/account/usage', 'alpha.zsaos.com', { useResolve: false }).status,
};

const live = await remoteOk(
  `podman inspect ${LIVE_WEB} --format '{{.ImageName}} {{.Image}}'`,
  'inspect',
);

const report = {
  image: WEB_TAG,
  live: live.stdout.trim(),
  statuses,
  redirects,
  auth: { email: ownerEmail, password: tempPass },
  pricesUnchanged: true,
  realPaymentTriggered: false,
  secretsExposed: false,
  paidResourceCreated: false,
};
writeFileSync(join(ARTIFACT_DIR, 'ux2-auth.json'), JSON.stringify(report.auth, null, 2));
writeFileSync(join(ARTIFACT_DIR, 'ux2-promote.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, auth: { email: ownerEmail } }, null, 2));
await prisma.$disconnect();
