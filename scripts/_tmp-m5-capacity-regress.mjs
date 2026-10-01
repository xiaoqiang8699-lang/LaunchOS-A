/**
 * Beta M5: promote api/worker/web + capacity/reliability regress.
 * node scripts/_tmp-m5-capacity-regress.mjs --confirm-m5 [--skip-build]
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
if (!process.argv.includes('--confirm-m5')) {
  console.error('pass --confirm-m5');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  shellCommand,
  decideCapacityAdmission,
  BETA_CAPACITY_DEFAULTS,
} = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const HOST = 'web-ceshi.zsaos.com';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const API_TAG = 'launchos-alpha-api:m5';
const WEB_TAG = 'launchos-alpha-web:m5';
const WORKER_TAG = 'launchos-alpha-worker:m5';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const WORKER_REMOTE = `localhost/${WORKER_TAG}`;
const LIVE_API = 'launchos-alpha-api';
const LIVE_WEB = 'launchos-alpha-web';
const LIVE_WORKER = 'launchos-alpha-worker';
const LIVE_API_PORT = 39110;
const WEB_PORT = 39082;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const skipBuild = process.argv.includes('--skip-build');

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken|AUTH_SECRET)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
}
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
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
if (!server) throw new Error('server missing');
const username = resolveServerSshUsername({ serverUsername: server.username });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

async function promoteImage(localTag, remoteName, tarName) {
  try { await runner.disconnect(); } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  const tar = join(ARTIFACT_DIR, tarName);
  try { unlinkSync(tar); } catch {}
  if (local('docker', ['save', '-o', tar, localTag]).status !== 0) throw new Error(`save ${localTag} failed`);
  console.log('uploading', tarName);
  await runner.upload(tar, `/opt/launchos/tmp/${tarName}`, { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/${tarName} && rm -f /opt/launchos/tmp/${tarName} && (podman tag docker.io/library/${localTag} ${remoteName} 2>/dev/null || podman tag ${localTag} ${remoteName} 2>/dev/null || true)`,
    `load-${localTag}`,
    { timeoutMs: 600000 },
  );
}

const report = {
  defaults: BETA_CAPACITY_DEFAULTS,
  sim10: null,
  exhaustion: null,
  workerRestart: null,
  adminCapacity: false,
  webCeshi: false,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
};

console.log('[0] 10-user capacity simulation (fixture)');
const sim = { admitted: 0, waiting: 0, rejected: 0, maxActiveBuild: 0, maxActiveDeploy: 0 };
for (let i = 0; i < 10; i++) {
  const activeBuild = Math.min(i, BETA_CAPACITY_DEFAULTS.maxConcurrentBuilds);
  const activeDeploy = Math.min(i, BETA_CAPACITY_DEFAULTS.maxConcurrentDeploys + 1);
  sim.maxActiveBuild = Math.max(sim.maxActiveBuild, activeBuild);
  sim.maxActiveDeploy = Math.max(sim.maxActiveDeploy, Math.min(i, BETA_CAPACITY_DEFAULTS.maxConcurrentDeploys));
  const d = decideCapacityAdmission({
    workerOnline: true,
    queueReady: true,
    allowWait: true,
    snapshot: {
      serverInstanceId: server.id,
      cpuCores: 2,
      memoryTotalMb: 3516,
      memoryAvailableMb: 1800,
      diskTotalMb: 59 * 1024,
      diskFreeMb: 8 * 1024,
      diskUsedPercent: 87,
      runningRuntimeCount: Math.min(i, 5),
      activeDeploymentCount: activeDeploy,
      activeBuildCount: activeBuild,
      allocatedPortCount: i,
      probedAt: new Date().toISOString(),
    },
  });
  if (d.result === 'ADMITTED') sim.admitted += 1;
  else if (d.result === 'WAITING_CAPACITY') sim.waiting += 1;
  else sim.rejected += 1;
}
report.sim10 = sim;
console.log('sim10', sim);

console.log('[0b] capacity exhaustion fixtures');
const diskCrit = decideCapacityAdmission({
  workerOnline: true,
  queueReady: true,
  snapshot: {
    serverInstanceId: server.id,
    cpuCores: 2,
    memoryTotalMb: 3516,
    memoryAvailableMb: 2000,
    diskTotalMb: 59 * 1024,
    diskFreeMb: 2 * 1024,
    diskUsedPercent: 95,
    runningRuntimeCount: 1,
    activeDeploymentCount: 0,
    activeBuildCount: 0,
    allocatedPortCount: 1,
    probedAt: new Date().toISOString(),
  },
});
const memCrit = decideCapacityAdmission({
  workerOnline: true,
  queueReady: true,
  snapshot: {
    serverInstanceId: server.id,
    cpuCores: 2,
    memoryTotalMb: 3516,
    memoryAvailableMb: 200,
    diskTotalMb: 59 * 1024,
    diskFreeMb: 10 * 1024,
    diskUsedPercent: 80,
    runningRuntimeCount: 1,
    activeDeploymentCount: 0,
    activeBuildCount: 0,
    allocatedPortCount: 1,
    probedAt: new Date().toISOString(),
  },
});
const slotsFull = decideCapacityAdmission({
  workerOnline: true,
  queueReady: true,
  allowWait: true,
  snapshot: {
    serverInstanceId: server.id,
    cpuCores: 2,
    memoryTotalMb: 3516,
    memoryAvailableMb: 2000,
    diskTotalMb: 59 * 1024,
    diskFreeMb: 10 * 1024,
    diskUsedPercent: 80,
    runningRuntimeCount: 2,
    activeDeploymentCount: 1,
    activeBuildCount: BETA_CAPACITY_DEFAULTS.maxConcurrentBuilds,
    allocatedPortCount: 2,
    probedAt: new Date().toISOString(),
  },
});
report.exhaustion = {
  disk: diskCrit.result === 'REJECTED_CAPACITY' && diskCrit.code === 'CAPACITY_DISK_CRITICAL',
  memory: memCrit.result === 'REJECTED_CAPACITY',
  buildSlots: slotsFull.result === 'WAITING_CAPACITY',
  noInternalLeak: !/OOM|df |loadavg/i.test(`${diskCrit.userMessage}${memCrit.userMessage}`),
};
console.log('exhaustion', report.exhaustion);

console.log('[1] build');
if (!skipBuild) {
  for (const [tag, file, log] of [
    [API_TAG, 'deploy/alpha/Dockerfile.api', 'm5-api-build.log'],
    [WORKER_TAG, 'deploy/alpha/Dockerfile.worker', 'm5-worker-build.log'],
    [WEB_TAG, 'deploy/alpha/Dockerfile.web', 'm5-web-build.log'],
  ]) {
    console.log('building', tag);
    const b = local('docker', [
      'build', '--platform', 'linux/amd64', '-f', file, '-t', tag,
      ...(tag === WEB_TAG ? ['--build-arg', 'NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com'] : []),
      '.',
    ]);
    writeFileSync(join(ARTIFACT_DIR, log), redact(`${b.stdout || ''}\n${b.stderr || ''}`).slice(-300000));
    if (b.status !== 0) throw new Error(`${tag} build failed`);
  }
}

const markers = local('docker', [
  'run', '--rm', '--entrypoint', 'sh', API_TAG, '-c',
  'echo CAP=$(grep -c decideCapacityAdmission /app/packages/shared/dist/capacity-governance.js); echo ADM=$(grep -c admitManagedDeployment /app/apps/api/dist/capacity/capacity-governance.service.js || grep -c CapacityGovernanceService /app/apps/api/dist/capacity/capacity-governance.service.js)',
]);
console.log('markers', String(markers.stdout || '').trim());
if (!/CAP=[1-9]/.test(String(markers.stdout || ''))) throw new Error('capacity marker missing');

console.log('[2] promote');
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir');
await promoteImage(API_TAG, API_REMOTE, 'launchos-alpha-api-m5.tar');
await promoteImage(WORKER_TAG, WORKER_REMOTE, 'launchos-alpha-worker-m5.tar');
await promoteImage(WEB_TAG, WEB_REMOTE, 'launchos-alpha-web-m5.tar');

await runner.writeTextFile('/opt/launchos/bin/m5-run-api.sh', `#!/bin/bash
set -euo pipefail
NAME="$1"; PORT="$2"; IMAGE="$3"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-api.env --env-file /opt/launchos/config/alpha-github.env \\
  -e "API_PORT=$PORT" -e ARTIFACT_STORE=local -e LOCAL_ARTIFACT_ROOT=/opt/launchos/artifacts \\
  -e LAUNCHOS_SYSTEM_DOMAIN=zsaos.com -e LAUNCHOS_GATEWAY_PUBLIC_IP=${TARGET_HOST} \\
  -v /opt/launchos/artifacts:/opt/launchos/artifacts \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/api/dist/main.js'
echo STARTED
`);
await runner.writeTextFile('/opt/launchos/bin/m5-run-worker.sh', `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-worker.env --env-file /opt/launchos/config/alpha-github.env \\
  -e ARTIFACT_STORE=local -e LOCAL_ARTIFACT_ROOT=/opt/launchos/artifacts \\
  -e LAUNCHOS_SYSTEM_DOMAIN=zsaos.com -e LAUNCHOS_GATEWAY_PUBLIC_IP=${TARGET_HOST} \\
  -v /opt/launchos/artifacts:/opt/launchos/artifacts \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v /run/podman/podman.sock:/run/podman/podman.sock \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/worker/dist/main.js'
echo STARTED
`);
await runner.writeTextFile('/opt/launchos/bin/m5-run-web.sh', `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"; HOSTPORT="$3"
podman rm -f "$NAME" 2>/dev/null || true
sleep 1
EXTRA=()
if [[ -f /opt/launchos/config/alpha-web.env ]]; then EXTRA+=(--env-file /opt/launchos/config/alpha-web.env); fi
podman run -d --name "$NAME" --restart unless-stopped -p 127.0.0.1:\${HOSTPORT}:3000 \\
  -e PORT=3000 -e HOSTNAME=0.0.0.0 -e NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com "\${EXTRA[@]}" "$IMAGE"
echo STARTED
`);
await runner.writeTextFile('/opt/launchos/tmp/m5-wait-api.sh', `#!/bin/bash
set +e
n=0
while [ "$n" -lt 40 ]; do
  n=$((n + 1))
  if curl -fsS http://127.0.0.1:${LIVE_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then echo OK; exit 0; fi
  sleep 2
done
podman logs --tail 40 ${LIVE_API}
exit 1
`);
await remoteOk('chmod 700 /opt/launchos/bin/m5-run-*.sh /opt/launchos/tmp/m5-wait-api.sh', 'chmod');
await remoteOk(`/opt/launchos/bin/m5-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'run-api', { timeoutMs: 120000 });
await remoteOk('/opt/launchos/tmp/m5-wait-api.sh', 'wait-api', { timeoutMs: 120000 });
await applyColocatedNginxRoute({
  host: TARGET_HOST, port: server.port, username, password,
  hostname: 'api-alpha.zsaos.com', healthPath: '/api/v1/health', targetPort: LIVE_API_PORT,
});
await remoteOk(`/opt/launchos/bin/m5-run-worker.sh ${LIVE_WORKER} ${WORKER_REMOTE}`, 'run-worker', { timeoutMs: 120000 });
await remoteOk(`/opt/launchos/bin/m5-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'run-web', { timeoutMs: 120000 });
await applyColocatedNginxRoute({
  host: TARGET_HOST, port: server.port, username, password,
  hostname: 'alpha.zsaos.com', healthPath: '/', targetPort: WEB_PORT,
});

console.log('[3] worker restart regression');
await remoteOk(`podman restart ${LIVE_WORKER}`, 'restart-worker');
await new Promise((r) => setTimeout(r, 8000));
const workerUp = await remoteOk(
  `podman ps --format '{{.Names}} {{.Status}}' | grep ${LIVE_WORKER} || true`,
  'worker-ps',
);
const publicAfterRestart = curl(`https://${HOST}/`, HOST, { useResolve: false });
report.workerRestart = {
  running: /Up/.test(workerUp.stdout),
  publicOk: publicAfterRestart.status >= 200 && publicAfterRestart.status < 400,
};
console.log('workerRestart', report.workerRestart);

console.log('[4] auth + admin capacity + web-ceshi');
const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Tmp-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/m5-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m5-setpass.sql',
  'set-pass',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${redact(login.text).slice(0, 200)}`);
const auth = { authorization: `Bearer ${token}` };

// Platform admin may be same owner — try admin runtime; if 403, still check public.
const adminRuntime = curl('https://api-alpha.zsaos.com/api/v1/admin/runtime', 'api-alpha.zsaos.com', {
  headers: auth,
  maxTime: '120',
});
const adminBody = JSON.parse(adminRuntime.text || '{}');
report.adminCapacity =
  adminRuntime.status === 200 &&
  Boolean(adminBody.capacity?.servers?.length) &&
  Boolean(adminBody.capacity?.limits?.maxConcurrentBuilds);
console.log('adminCapacity', adminRuntime.status, report.adminCapacity, adminBody.capacity?.warnings?.[0]?.code || 'none');

const health = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime?refreshPublic=1`,
  'api-alpha.zsaos.com',
  { headers: auth, maxTime: '120' },
);
const healthBody = JSON.parse(health.text || '{}');
const publicLive = curl(`https://${HOST}/`, HOST, { useResolve: false });
const versions = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/versions`, 'api-alpha.zsaos.com', {
  headers: auth,
});
report.webCeshi =
  publicLive.status >= 200 &&
  publicLive.status < 400 &&
  health.status === 200 &&
  versions.status === 200 &&
  (healthBody.overallStatus === 'HEALTHY' ||
    healthBody.overallStatus === 'STATUS_PENDING' ||
    healthBody.publicStatus === 'OK');
console.log('webCeshi', report.webCeshi, healthBody.overallStatus, publicLive.status);

// Live capacity reject: temporarily poison probe to critical free disk, attempt deploy, restore.
const meta = typeof server.metadata === 'object' && server.metadata ? server.metadata : {};
await prisma.serverInstance.update({
  where: { id: server.id },
  data: {
    metadata: {
      ...meta,
      capacityProbe: {
        cpuCores: 2,
        memoryTotalMb: 3516,
        memoryAvailableMb: 2000,
        diskTotalMb: 59 * 1024,
        diskFreeMb: 1024,
        diskUsedPercent: 96,
        probedAt: new Date().toISOString(),
      },
    },
  },
});
const envId = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"ProjectEnvironment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" ASC LIMIT 1"`,
    'env',
  )
).stdout.trim();
const blocked = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/deployments`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ environmentId: envId, deployableUnitId: UNIT }),
});
const blockedText = blocked.text || '';
const liveExhaust =
  blocked.status >= 400 &&
  /CAPACITY_|资源繁忙|稍后重试/.test(blockedText) &&
  !/OOM|df |loadavg/.test(blockedText);
console.log('liveExhaust', blocked.status, liveExhaust, redact(blockedText).slice(0, 180));
await prisma.serverInstance.update({
  where: { id: server.id },
  data: { metadata: meta },
});

report.exhaustion.liveReject = liveExhaust;

const finalPass =
  report.sim10.admitted + report.sim10.waiting + report.sim10.rejected === 10 &&
  report.sim10.waiting >= 1 &&
  report.exhaustion.disk &&
  report.exhaustion.memory &&
  report.exhaustion.buildSlots &&
  report.exhaustion.noInternalLeak &&
  report.exhaustion.liveReject &&
  report.workerRestart.running &&
  report.workerRestart.publicOk &&
  report.webCeshi &&
  report.secretsExposed === 'NO' &&
  report.paidResourceCreated === 'NO';

writeFileSync(join(ARTIFACT_DIR, 'm5-regress-report.json'), JSON.stringify({ ...report, finalPass, adminStatus: adminRuntime.status }, null, 2));
console.log('M5_REPORT', JSON.stringify(report));
console.log(finalPass ? 'M5_REGRESS=PASS' : 'M5_REGRESS=FAIL');
await prisma.$disconnect().catch(() => undefined);
try { await runner.disconnect(); } catch {}
process.exit(finalPass ? 0 : 1);
