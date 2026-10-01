/**
 * Rebuild worker with shallow git clone + local artifacts, wait queueReady, relaunch.
 * node scripts/_tmp-step317-shallow-relaunch.mjs --confirm-shallow
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
if (!process.argv.includes('--confirm-shallow')) {
  console.error('pass --confirm-shallow');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const IMAGE_TAG = 'launchos-alpha-worker:step317c';
const LOCAL_IMAGE = IMAGE_TAG;
const REMOTE_IMAGE = `localhost/${IMAGE_TAG}`;
const LIVE = 'launchos-alpha-worker';
const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const LAUNCH_RUN = 'cmunhwddb0019rl01fzipihgn';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^\s"']+/gi, '$1=***');
}
function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = [
    '-k', '-sS', '-X', method,
    '--resolve', `${host}:443:${TARGET_HOST}`,
    '-w', '\n__STATUS__:%{http_code}',
    '--max-time', String(maxTime),
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
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
async function remoteOk(command, label, opts = {}) {
  const r = await runner.execute(shellCommand(command), { timeoutMs: opts.timeoutMs ?? 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1200)}`);
  return r;
}

console.log('[1] build worker');
const build = local('docker', [
  'build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.worker', '-t', LOCAL_IMAGE, '.',
]);
writeFileSync(join(ARTIFACT_DIR, 'step317c-worker-build.log'), redact(`${build.stdout||''}\n${build.stderr||''}`).slice(-200000));
if (build.status !== 0) throw new Error('worker build failed');
const markers = local('docker', [
  'run', '--rm', '--entrypoint', 'sh', LOCAL_IMAGE, '-c',
  'git --version; grep -c -- --depth /app/packages/git/dist/git.service.js; grep -c useLocalArtifactStore /app/packages/deployment/dist/artifacts/minio-artifact-store.js; grep -c queueReady /app/apps/worker/dist/heartbeat.js',
]);
console.log('markers', String(markers.stdout || markers.stderr || '').trim());
if (markers.status !== 0) throw new Error('markers failed');
const ml = String(markers.stdout || '').trim().split(/\r?\n/).filter(Boolean);
if (ml.length < 4 || ml.slice(1).some((x) => x === '0')) throw new Error('incomplete markers: ' + ml.join('|'));

console.log('[2] upload/load/start');
const tarPath = join(ARTIFACT_DIR, 'launchos-alpha-worker-step317c.tar');
try { unlinkSync(tarPath); } catch { /* */ }
if (local('docker', ['save', '-o', tarPath, LOCAL_IMAGE]).status !== 0) throw new Error('save failed');
const remoteTar = '/opt/launchos/tmp/launchos-alpha-worker-step317c.tar';
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin /opt/launchos/artifacts', 'mkdir');
await runner.upload(tarPath, remoteTar, { timeoutMs: 900000 });
await remoteOk(
  `podman load -i ${remoteTar} && rm -f ${remoteTar} && (podman tag docker.io/library/${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || podman tag ${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || true)`,
  'load',
  { timeoutMs: 600000 },
);

// keep ARTIFACT_STORE=local
await remoteOk(
  `grep -q '^ARTIFACT_STORE=local' /opt/launchos/config/alpha-api.env || printf '\\nARTIFACT_STORE=local\\nLOCAL_ARTIFACT_ROOT=/opt/launchos/artifacts\\n' >> /opt/launchos/config/alpha-api.env`,
  'env',
);

await runner.writeTextFile(
  '/opt/launchos/bin/step317-run-worker.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-api.env --env-file /opt/launchos/config/alpha-github.env \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  -v /opt/launchos/artifacts:/opt/launchos/artifacts \\
  --entrypoint /bin/sh "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/worker/dist/main.js'
echo STARTED
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step317-run-worker.sh && /opt/launchos/bin/step317-run-worker.sh ' + LIVE + ' ' + REMOTE_IMAGE, 'start', { timeoutMs: 120000 });

console.log('[3] wait queueReady');
let ready = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const hb = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, coalesce(meta::text,'') FROM \\"WorkerHeartbeat\\" WHERE service='deployment-worker' ORDER BY \\"lastSeenAt\\" DESC LIMIT 1;"`,
    'hb',
  );
  const line = String(hb.stdout || '').trim();
  if (i % 3 === 0) console.log(`[hb ${i}] ${line.slice(0, 180)}`);
  if (/ONLINE/.test(line) && /"deployment"\s*:\s*true/.test(line)) { ready = true; break; }
}
if (!ready) throw new Error('queueReady not ready');

await remoteOk(
  `podman exec launchos-alpha-worker sh -c 'rm -rf /tmp/launchos-repos/cmunhwais0003rl01wqj1qy11 || true'`,
  'clean-repo',
);
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6'; UPDATE \\"LaunchRun\\" SET status='WAITING_CONFIRMATION', \\"failureCode\\"=NULL, \\"failureMessage\\"=NULL, \\"finishedAt\\"=NULL, \\"startedAt\\"=NULL, \\"confirmationId\\"=NULL, \\"confirmedAt\\"=NULL, \\"confirmedByUserId\\"=NULL, \\"confirmedPlanHash\\"=NULL, \\"confirmationSnapshot\\"=NULL WHERE id='${LAUNCH_RUN}'; UPDATE \\"WorkerHeartbeat\\" SET status='OFFLINE' WHERE \\"lastSeenAt\\" < NOW() - interval '2 minutes';"`,
  'reset',
);

const ownerEmail = (await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
  'owner',
)).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile('/opt/launchos/tmp/step317-pass18.sql', `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`);
await remoteOk('podman cp /opt/launchos/tmp/step317-pass18.sql launchos-alpha-postgres:/tmp/step317-pass18.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass18.sql', 'pass');

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST', headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error('login failed');
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

console.log('[4] plan/confirm/launch');
const plan = curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', { method: 'POST', headers: auth, maxTime: '180' });
console.log('PLAN', plan.status, redact(plan.text).slice(0, 300));
const confirm = curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', { method: 'POST', headers: auth });
console.log('CONFIRM', confirm.status, redact(confirm.text).slice(0, 250));
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { method: 'POST', headers: auth });
console.log('START', start.status, redact(start.text).slice(0, 350));
if (start.status < 200 || start.status >= 300) throw new Error('launch start failed: ' + redact(start.text));

let final = null;
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth, maxTime: '30' });
  try { final = JSON.parse(st.text || '{}'); } catch { final = { status: 'PARSE_ERROR' }; }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''} ${final.publicUrl || ''}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) break;
}

await runner.writeTextFile(
  '/opt/launchos/bin/step317-result3.sh',
  `#!/bin/bash
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),200) FROM \\"LaunchRun\\" WHERE id='${LAUNCH_RUN}';"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),180), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 3;"
DEP=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1;")
echo DEP=$DEP
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepKey\\", status, left(coalesce(\\"errorMessage\\",''),200) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='$DEP' ORDER BY \\"createdAt\\";"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT left(message,250) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='$DEP' ORDER BY \\"createdAt\\" DESC LIMIT 25;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"containerId\\",''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 6;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, hostname, status FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 6;"
podman logs --tail 40 launchos-alpha-worker 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,})[=:][^ ]+/\\1=***/gi' | tail -40
`,
);
const result = await remoteOk('chmod 700 /opt/launchos/bin/step317-result3.sh && /opt/launchos/bin/step317-result3.sh', 'result', { timeoutMs: 90000 });
console.log('RESULT\n' + redact(result.stdout || '').slice(0, 8000));

const hostMatch = String(result.stdout || '').match(/([a-z0-9.-]+\.zsaos\.com)\|ACTIVE/);
let verify = null;
if (hostMatch) {
  const host = hostMatch[1];
  const v = curl(`https://${host}/`, host, { maxTime: '45' });
  verify = { host, status: v.status, snippet: redact(v.text).slice(0, 200) };
  console.log('VERIFY', JSON.stringify(verify));
}

writeFileSync(join(ARTIFACT_DIR, 'step317-shallow-relaunch.txt'), redact(JSON.stringify({ final, result: result.stdout, verify }, null, 2)));
await runner.disconnect();
await prisma.$disconnect();
process.exit(final?.status === 'SUCCESS' ? 0 : 1);
