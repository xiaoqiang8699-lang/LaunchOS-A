/**
 * Step 37: build/promote LaunchOS Alpha Web with history/versions routes.
 * node scripts/_tmp-step37-promote-web.mjs --confirm
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
if (!process.argv.includes('--confirm')) {
  console.error('pass --confirm');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const WEB_TAG = 'launchos-alpha-web:step37';
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_WEB = 'launchos-alpha-web';
const HOST_PORT = 39082;
const PROJECT_ID = 'cmunsm2lk00ctrl01nnu1pwyd';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
if (!server) throw new Error('server missing');
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

console.log('[1] build web');
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
writeFileSync(join(ARTIFACT_DIR, 'step37-web-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-300000));
if (b.status !== 0) throw new Error('web build failed');

console.log('[2] save/upload/load');
const tar = join(ARTIFACT_DIR, 'launchos-alpha-web-step37.tar');
try {
  unlinkSync(tar);
} catch {}
if (local('docker', ['save', '-o', tar, WEB_TAG]).status !== 0) throw new Error('save failed');
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir');
await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-web-step37.tar', { timeoutMs: 600000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-web-step37.tar && rm -f /opt/launchos/tmp/launchos-alpha-web-step37.tar && (podman tag docker.io/library/${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || podman tag ${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || true)`,
  'load',
  { timeoutMs: 300000 },
);

console.log('[3] recreate web');
await runner.writeTextFile(
  '/opt/launchos/bin/step37-run-web.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"; HOSTPORT="$3"
podman rm -f "$NAME" 2>/dev/null || true
sleep 1
ENV_FILE=/opt/launchos/config/alpha-web.env
EXTRA=()
if [[ -f "$ENV_FILE" ]]; then EXTRA+=(--env-file "$ENV_FILE"); fi
podman run -d --name "$NAME" --restart unless-stopped \\
  -p 127.0.0.1:\${HOSTPORT}:3000 \\
  -e PORT=3000 \\
  -e HOSTNAME=0.0.0.0 \\
  -e NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com \\
  "\${EXTRA[@]}" \\
  "$IMAGE"
echo STARTED
sleep 2
podman logs --tail 20 "$NAME" 2>&1 || true
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step37-run-web.sh', 'chmod');
await remoteOk(`/opt/launchos/bin/step37-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${HOST_PORT}`, 'run-web', {
  timeoutMs: 120000,
});

console.log('[4] nginx alpha.zsaos.com -> web');
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'alpha.zsaos.com',
  healthPath: '/',
  targetPort: HOST_PORT,
});

console.log('[5] verify routes + APIs');
await runner.writeTextFile(
  '/opt/launchos/tmp/step37-verify.sh',
  `#!/bin/bash
set +e
echo LOCAL=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:${HOST_PORT}/)
echo PUBLIC=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://alpha.zsaos.com/)
echo HIST=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://alpha.zsaos.com/projects/${PROJECT_ID}/deployments)
echo VERS=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://alpha.zsaos.com/projects/${PROJECT_ID}/versions)
echo PROJ=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://alpha.zsaos.com/projects/${PROJECT_ID})
podman inspect ${LIVE_WEB} --format '{{.Config.Image}}'
podman exec ${LIVE_WEB} sh -c 'find /app/apps/web/.next/server/app/projects -maxdepth 3 -type d 2>/dev/null | head -40'
`,
);
const verify = await remoteOk(
  'chmod 700 /opt/launchos/tmp/step37-verify.sh && /opt/launchos/tmp/step37-verify.sh',
  'verify',
  { timeoutMs: 90000 },
);
console.log(verify.stdout);

const deps = await prisma.deployment.findMany({
  where: { projectId: PROJECT_ID },
  orderBy: { createdAt: 'desc' },
  take: 8,
  select: { id: true, version: true, status: true, sourceRevision: true, errorMessage: true, createdAt: true },
});
const vers = await prisma.applicationVersion.findMany({
  where: { projectId: PROJECT_ID },
  orderBy: { createdAt: 'desc' },
  take: 8,
  select: { id: true, version: true, status: true, commitSha: true, deploymentId: true },
});
const report = {
  routes: String(verify.stdout || ''),
  deployments: deps,
  versions: vers,
};
writeFileSync(join(ARTIFACT_DIR, 'step37-regress.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ depCount: deps.length, versionCount: vers.length, sample: deps.slice(0, 3) }, null, 2));

await runner.disconnect();
await prisma.$disconnect();

const localCode = Number((String(verify.stdout || '').match(/LOCAL=(\d+)/) || [])[1] || 0);
const publicCode = Number((String(verify.stdout || '').match(/PUBLIC=(\d+)/) || [])[1] || 0);
const histCode = Number((String(verify.stdout || '').match(/HIST=(\d+)/) || [])[1] || 0);
const versCode = Number((String(verify.stdout || '').match(/VERS=(\d+)/) || [])[1] || 0);
const pass =
  localCode === 200 &&
  publicCode === 200 &&
  histCode === 200 &&
  versCode === 200 &&
  deps.some((d) => d.version === 'v15' || d.status === 'SUCCESS') &&
  vers.length > 0;
console.log(
  pass
    ? 'STEP37_REGRESS=PASS'
    : `STEP37_REGRESS=FAIL local=${localCode} public=${publicCode} hist=${histCode} vers=${versCode}`,
);
process.exit(pass ? 0 : 1);
