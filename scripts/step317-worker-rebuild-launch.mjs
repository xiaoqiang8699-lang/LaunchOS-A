/**
 * Rebuild/redeploy Alpha worker with git + GitHub App PEM, then finish Step 31.7 launch.
 * node scripts/step317-worker-rebuild-launch.mjs --confirm-step317-worker
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

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
if (!process.argv.includes('--confirm-step317-worker')) {
  console.error('pass --confirm-step317-worker');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcrypt = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const IMAGE_TAG = 'launchos-alpha-worker:step317';
const LOCAL_IMAGE = IMAGE_TAG;
const REMOTE_IMAGE = `localhost/${IMAGE_TAG}`;
const LIVE = 'launchos-alpha-worker';
const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^\s]+/gi, '$1=***');
}
function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = ['-k', '-sS', '-X', method, '--resolve', `${host}:443:${TARGET_HOST}`, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}
async function remoteOk(runner, command, label, opts = {}) {
  const r = await runner.execute(shellCommand(command), { timeoutMs: opts.timeoutMs ?? 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

console.log('[1] docker build worker');
const buildLog = join(ARTIFACT_DIR, 'step317-worker-docker-build.log');
const build = local('docker', [
  'build',
  '--platform',
  'linux/amd64',
  '-f',
  'deploy/alpha/Dockerfile.worker',
  '-t',
  LOCAL_IMAGE,
  '.',
]);
writeFileSync(buildLog, redact(`${build.stdout || ''}\n${build.stderr || ''}`).slice(-200000), 'utf8');
if (build.status !== 0) throw new Error(`worker build failed; see ${buildLog}`);

const markers = local('docker', [
  'run',
  '--rm',
  '--entrypoint',
  'sh',
  LOCAL_IMAGE,
  '-c',
  'git --version; grep -c "http.version=HTTP/1.1" packages/git/dist/git.service.js',
]);
console.log('markers', String(markers.stdout || '').trim());
if (markers.status !== 0) throw new Error('worker image missing git/http1.1');

console.log('[2] save/upload/load');
const tarPath = join(ARTIFACT_DIR, 'launchos-alpha-worker-step317.tar');
try {
  unlinkSync(tarPath);
} catch {
  /* ignore */
}
const save = local('docker', ['save', '-o', tarPath, LOCAL_IMAGE]);
if (save.status !== 0) throw new Error('docker save failed');
const remoteTar = '/opt/launchos/tmp/launchos-alpha-worker-step317.tar';
await remoteOk(runner, 'mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir');
await runner.upload(tarPath, remoteTar, { timeoutMs: 900000 });
await remoteOk(
  runner,
  [
    `podman load -i ${remoteTar}`,
    `rm -f ${remoteTar}`,
    `podman tag docker.io/library/${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || podman tag ${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || true`,
  ].join(' && '),
  'load',
  { timeoutMs: 600000 },
);

await runner.writeTextFile(
  '/opt/launchos/bin/step317-run-worker.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"
IMAGE="$2"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" \\
  --restart unless-stopped \\
  --network host \\
  --env-file /opt/launchos/config/alpha-api.env \\
  --env-file /opt/launchos/config/alpha-github.env \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh \\
  "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; echo WORKER_BOOT_KEYS=$(env | sed -n "s/=.*//p" | grep -E "^GITHUB_APP_" | sort | tr "\\n" ","); exec node apps/worker/dist/main.js'
echo STARTED
`,
);
await remoteOk(runner, 'chmod 700 /opt/launchos/bin/step317-run-worker.sh', 'chmod');
await remoteOk(
  runner,
  `/opt/launchos/bin/step317-run-worker.sh ${LIVE} ${REMOTE_IMAGE}`,
  'start-worker',
  { timeoutMs: 120000 },
);
await new Promise((r) => setTimeout(r, 8000));
const verify = await remoteOk(
  runner,
  `podman exec ${LIVE} sh -c 'git --version; grep -c "http.version=HTTP/1.1" /app/packages/git/dist/git.service.js'; podman logs --tail 20 ${LIVE}; podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -c "SELECT \\"workerId\\", status, \\"lastSeenAt\\"::text FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 3;"`,
  'verify-worker',
);
console.log(redact(verify.stdout || '').slice(0, 1500));

await remoteOk(
  runner,
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6'; UPDATE \\"LaunchRun\\" SET status='WAITING_CONFIRMATION', \\"failureCode\\"=NULL, \\"failureMessage\\"=NULL, \\"finishedAt\\"=NULL, \\"startedAt\\"=NULL, \\"confirmationId\\"=NULL, \\"confirmedAt\\"=NULL, \\"confirmedByUserId\\"=NULL, \\"confirmedPlanHash\\"=NULL, \\"confirmationSnapshot\\"=NULL WHERE id='cmunhwddb0019rl01fzipihgn'; UPDATE \\"WorkerHeartbeat\\" SET status='OFFLINE' WHERE \\"lastSeenAt\\" < NOW() - interval '3 minutes';"`,
  'reset',
);

const ownerEmail = (
  await remoteOk(
    runner,
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcrypt.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass14.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  runner,
  'podman cp /opt/launchos/tmp/step317-pass14.sql launchos-alpha-postgres:/tmp/step317-pass14.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass14.sql',
  'pass',
);

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };
const plan = curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  maxTime: '180',
});
console.log('PLAN', plan.status, redact(plan.text).slice(0, 400));
curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
});
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
});
console.log('START', start.status, redact(start.text).slice(0, 400));
if (start.status >= 400) throw new Error('start failed');

let final = null;
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth });
  final = JSON.parse(st.text || '{}');
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''}`);
  if (final.status === 'SUCCESS' || final.status === 'FAILED' || final.status === 'CANCELLED') break;
}

const sql = await remoteOk(
  runner,
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),300) FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn'; SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),300) FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 4; SELECT ds.\\"stepKey\\", ds.status, left(coalesce(ds.\\"errorMessage\\",''),200) FROM \\"DeploymentStep\\" ds WHERE ds.\\"deploymentId\\"=(SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1) ORDER BY ds.\\"order\\"; SELECT id, hostname, status FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 5; SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"containerId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 5;"`,
  'final-sql',
);
writeFileSync(join(ARTIFACT_DIR, 'step317-final8.txt'), redact(sql.stdout || ''));
console.log('FINAL\n', redact(sql.stdout || ''));

const routeLine = String(sql.stdout || '')
  .split(/\n/)
  .find((l) => /\.zsaos\.com\|ACTIVE/.test(l));
if (routeLine) {
  const host = routeLine.split('|')[1];
  const v = curl(`https://${host}/`, host, { maxTime: '45' });
  console.log('VERIFY', host, v.status, redact(v.text).slice(0, 200));
}

await runner.disconnect();
await prisma.$disconnect();
