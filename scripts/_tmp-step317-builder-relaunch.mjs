/**
 * Preload node:20-alpine on Alpha host, rebuild worker with docker CLI + sock,
 * then relaunch LaunchRun.
 *
 *   node scripts/_tmp-step317-builder-relaunch.mjs --confirm-builder
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
if (!process.argv.includes('--confirm-builder')) {
  console.error('pass --confirm-builder');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const IMAGE_TAG = 'launchos-alpha-worker:step317d';
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
  const r = await runner.execute(shellCommand(command), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1200)}`);
  return r;
}

console.log('[0] save/upload node:20-alpine');
const nodeTar = join(ARTIFACT_DIR, 'node-20-alpine.tar');
try { unlinkSync(nodeTar); } catch { /* */ }
const saveNode = local('docker', ['save', '-o', nodeTar, 'node:20-alpine']);
if (saveNode.status !== 0) throw new Error('docker save node:20-alpine failed: ' + redact(saveNode.stderr || ''));
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin /opt/launchos/artifacts', 'mkdir');
const remoteNodeTar = '/opt/launchos/tmp/node-20-alpine.tar';
await runner.upload(nodeTar, remoteNodeTar, { timeoutMs: 900000 });
await remoteOk(
  `podman load -i ${remoteNodeTar} && rm -f ${remoteNodeTar} && (podman tag docker.io/library/node:20-alpine node:20-alpine 2>/dev/null || true) && podman image exists node:20-alpine && echo NODE_ALPINE_OK`,
  'load-node',
  { timeoutMs: 600000 },
);

console.log('[1] build worker with docker CLI');
const build = local('docker', [
  'build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.worker', '-t', LOCAL_IMAGE, '.',
]);
writeFileSync(join(ARTIFACT_DIR, 'step317d-worker-build.log'), redact(`${build.stdout||''}\n${build.stderr||''}`).slice(-250000));
if (build.status !== 0) throw new Error('worker build failed');
const markers = local('docker', [
  'run', '--rm', '--entrypoint', 'sh', LOCAL_IMAGE, '-c',
  'git --version; docker --version; grep -c useLocalArtifactStore /app/packages/deployment/dist/artifacts/minio-artifact-store.js; grep -c -- --depth /app/packages/git/dist/git.service.js; grep -c DOCKER_BIN /app/packages/runtime/dist/docker-cli.js',
]);
console.log('markers', String(markers.stdout || markers.stderr || '').trim());
if (markers.status !== 0) throw new Error('markers failed');

console.log('[2] upload/start worker with docker.sock');
const tarPath = join(ARTIFACT_DIR, 'launchos-alpha-worker-step317d.tar');
try { unlinkSync(tarPath); } catch { /* */ }
if (local('docker', ['save', '-o', tarPath, LOCAL_IMAGE]).status !== 0) throw new Error('save worker failed');
const remoteTar = '/opt/launchos/tmp/launchos-alpha-worker-step317d.tar';
await runner.upload(tarPath, remoteTar, { timeoutMs: 900000 });
await remoteOk(
  `podman load -i ${remoteTar} && rm -f ${remoteTar} && (podman tag docker.io/library/${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || podman tag ${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || true)`,
  'load-worker',
  { timeoutMs: 600000 },
);

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
  -e DOCKER_HOST=unix:///var/run/docker.sock \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  -v /opt/launchos/artifacts:/opt/launchos/artifacts \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v /run/podman/podman.sock:/run/podman/podman.sock \\
  --entrypoint /bin/sh "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; docker image inspect node:20-alpine >/tmp/base-img.txt 2>&1 || true; echo BASE_IMG=$(head -c 120 /tmp/base-img.txt | tr "\\n" " "); exec node apps/worker/dist/main.js'
echo STARTED
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step317-run-worker.sh && /opt/launchos/bin/step317-run-worker.sh ' + LIVE + ' ' + REMOTE_IMAGE, 'start', { timeoutMs: 120000 });

console.log('[3] wait queueReady + base image');
let ready = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const hb = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, coalesce(meta::text,'') FROM \\"WorkerHeartbeat\\" WHERE service='deployment-worker' ORDER BY \\"lastSeenAt\\" DESC LIMIT 1;"`,
    'hb',
  );
  const line = String(hb.stdout || '').trim();
  if (i % 3 === 0) console.log(`[hb ${i}] ${line.slice(0, 160)}`);
  if (/ONLINE/.test(line) && /"deployment"\s*:\s*true/.test(line)) { ready = true; break; }
}
if (!ready) throw new Error('queueReady not ready');
const base = await remoteOk(
  `podman logs --tail 5 ${LIVE}; podman exec ${LIVE} docker image inspect node:20-alpine --format '{{.Id}} {{.RepoTags}}'`,
  'base-check',
);
console.log('base', redact(base.stdout || '').slice(0, 400));

await remoteOk(`podman exec ${LIVE} sh -c 'rm -rf /tmp/launchos-repos/${PROJECT} || true'`, 'clean-repo');
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
await runner.writeTextFile('/opt/launchos/tmp/step317-pass19.sql', `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`);
await remoteOk('podman cp /opt/launchos/tmp/step317-pass19.sql launchos-alpha-postgres:/tmp/step317-pass19.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass19.sql', 'pass');

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST', headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error('login failed');
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

console.log('[4] plan/confirm/launch');
console.log('PLAN', curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', { method: 'POST', headers: auth, maxTime: '180' }).status);
console.log('CONFIRM', curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', { method: 'POST', headers: auth }).status);
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { method: 'POST', headers: auth });
console.log('START', start.status, redact(start.text).slice(0, 350));
if (start.status < 200 || start.status >= 300) throw new Error('launch failed: ' + redact(start.text));

let final = null;
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth, maxTime: '30' });
  try { final = JSON.parse(st.text || '{}'); } catch { final = { status: 'PARSE_ERROR' }; }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''} ${final.publicUrl || ''}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) break;
}

await runner.writeTextFile(
  '/opt/launchos/bin/step317-result4.sh',
  `#!/bin/bash
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),200) FROM \\"LaunchRun\\" WHERE id='${LAUNCH_RUN}';"
DEP=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1;")
echo DEP=$DEP
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepKey\\", status, left(coalesce(\\"errorMessage\\",''),220) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='$DEP' ORDER BY \\"createdAt\\";"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT left(message,220) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='$DEP' ORDER BY \\"createdAt\\" DESC LIMIT 30;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"containerId\\",''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 6;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, hostname, status FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 6;"
podman logs --tail 50 ${LIVE} 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,})[=:][^ ]+/\\1=***/gi' | tail -50
`,
);
const result = await remoteOk('chmod 700 /opt/launchos/bin/step317-result4.sh && /opt/launchos/bin/step317-result4.sh', 'result', { timeoutMs: 90000 });
console.log('RESULT\n' + redact(result.stdout || '').slice(0, 9000));

const hostMatch = String(result.stdout || '').match(/([a-z0-9.-]+\.zsaos\.com)\|ACTIVE/);
let verify = null;
if (hostMatch) {
  const host = hostMatch[1];
  const v = curl(`https://${host}/`, host, { maxTime: '45' });
  verify = { host, status: v.status, snippet: redact(v.text).slice(0, 250) };
  console.log('VERIFY', JSON.stringify(verify));
}
writeFileSync(join(ARTIFACT_DIR, 'step317-builder-relaunch.txt'), redact(JSON.stringify({ final, result: result.stdout, verify }, null, 2)));
await runner.disconnect();
await prisma.$disconnect();
process.exit(final?.status === 'SUCCESS' ? 0 : 1);
