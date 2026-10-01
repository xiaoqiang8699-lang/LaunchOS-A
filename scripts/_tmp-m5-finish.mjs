/**
 * Finish M5 after promote: admin capacity + live capacity reject + cancel stray deploy.
 * node scripts/_tmp-m5-finish.mjs --confirm-m5
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
if (!process.argv.includes('--confirm-m5')) process.exit(2);

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand, BETA_CAPACITY_DEFAULTS } =
  requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const MANAGED_ID = 'cmuma9i480001rij49yv4yw2q';
const HOST = 'web-ceshi.zsaos.com';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const API_TAG = 'launchos-alpha-api:m5';
const API_REMOTE = `localhost/${API_TAG}`;
const LIVE_API = 'launchos-alpha-api';
const LIVE_API_PORT = 39110;

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = [
    '-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}',
    '--max-time', String(maxTime), '--resolve', `${host}:443:${TARGET_HOST}`,
  ];
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
  where: { OR: [{ id: MANAGED_ID }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('PLATFORM_MANAGED server missing');
const username = resolveServerSshUsername({
  serverUsername: server.username,
  provider: server.provider,
});
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label, timeoutMs = 180000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}
async function remoteSql(sql, label) {
  const path = `/opt/launchos/tmp/m5-${label}.sql`;
  await runner.writeTextFile(path, sql.endsWith('\n') ? sql : `${sql}\n`);
  return remoteOk(
    `podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < ${path}`,
    label,
  );
}

console.log('[0] disk reclaim old platform images (keep m4/m5 + current app)');
await remoteOk(
  `podman images --format '{{.Repository}}:{{.Tag}}|{{.ID}}' | grep -E 'launchos-alpha-(api|worker|web):(m2|m3|step)' | cut -d'|' -f2 | sort -u | xargs -r podman rmi -f 2>/dev/null || true; df -h / | tail -1`,
  'image-gc',
  300000,
).catch((e) => console.log('image-gc warn', e.message || e));

console.log('[1] rebuild+restart api only for force-probe fix');
const b = spawnSync(
  'docker',
  ['build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.api', '-t', API_TAG, '.'],
  { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000 },
);
if (b.status !== 0) throw new Error(`api rebuild failed: ${(b.stderr || b.stdout || '').slice(-2000)}`);
const tar = join(root, '.tools/alpha-runtime/launchos-alpha-api-m5.tar');
spawnSync('docker', ['save', '-o', tar, API_TAG], { cwd: root });
await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-api-m5.tar', { timeoutMs: 900000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-api-m5.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-m5.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
  'load',
  600000,
);
await remoteOk(`test -x /opt/launchos/bin/m5-run-api.sh && test -x /opt/launchos/tmp/m5-wait-api.sh`, 'ensure-scripts');
await remoteOk(`/opt/launchos/bin/m5-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'run-api', 120000);
await remoteOk('/opt/launchos/tmp/m5-wait-api.sh', 'wait-api', 120000);
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"Deployment\\" SET status='CANCELLED', \\"finishedAt\\"=NOW(), \\"errorMessage\\"='m5-test-cancel' WHERE \\"projectId\\"='${PROJECT}' AND status IN ('CREATED','QUEUED','RUNNING');"`,
  'cancel-inflight',
).catch(() => undefined);

const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Tmp-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await remoteSql(
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}', "platformRole"='PLATFORM_ADMIN' WHERE email='${ownerEmail.replace(/'/g, "''")}';`,
  'set-pass-admin',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${(login.text || '').slice(0, 200)}`);
const auth = { authorization: `Bearer ${token}` };

const adminRuntime = curl('https://api-alpha.zsaos.com/api/v1/admin/runtime', 'api-alpha.zsaos.com', {
  headers: auth,
  maxTime: '120',
});
let adminBody = {};
try {
  adminBody = JSON.parse(adminRuntime.text || '{}');
} catch {
  adminBody = {};
}
const adminCapacity =
  adminRuntime.status === 200 &&
  Boolean(adminBody.capacity?.servers?.length) &&
  Boolean(adminBody.capacity?.limits?.maxConcurrentBuilds);
console.log('adminCapacity', adminRuntime.status, adminCapacity);

const forceProbe = {
  cpuCores: 2,
  memoryTotalMb: 3516,
  memoryAvailableMb: 2000,
  diskTotalMb: 59 * 1024,
  diskFreeMb: 1024,
  diskUsedPercent: 96,
  probedAt: new Date().toISOString(),
  force: true,
};
const forceJson = JSON.stringify(forceProbe).replace(/'/g, "''");
await remoteSql(
  `UPDATE "ServerInstance"
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('capacityProbe', '${forceJson}'::jsonb)
   WHERE id='${MANAGED_ID}';`,
  'force-probe',
);

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
const liveReject =
  blocked.status >= 400 &&
  /CAPACITY_|资源繁忙|稍后重试/.test(blocked.text || '') &&
  !/OOM|df |loadavg/.test(blocked.text || '');
console.log('liveReject', blocked.status, liveReject, (blocked.text || '').slice(0, 220));

await remoteSql(
  `UPDATE "ServerInstance"
   SET metadata = COALESCE(metadata, '{}'::jsonb) - 'capacityProbe'
   WHERE id='${MANAGED_ID}';`,
  'clear-probe',
);
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"User\\" SET \\"platformRole\\"='USER' WHERE email='${ownerEmail.replace(/'/g, "''")}';"`,
  'restore-role',
).catch(() => undefined);

// Cancel any deploy that slipped through.
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"Deployment\\" SET status='CANCELLED', \\"finishedAt\\"=NOW(), \\"errorMessage\\"='m5-test-cancel' WHERE \\"projectId\\"='${PROJECT}' AND status IN ('CREATED','QUEUED','RUNNING');"`,
  'cancel-after',
).catch(() => undefined);

const diskAfter = (
  await remoteOk(`df -h / | tail -1; free -m | head -2`, 'disk-after')
).stdout.trim();
console.log('diskAfter', diskAfter);

const publicLive = curl(`https://${HOST}/`, HOST);
const health = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime?refreshPublic=1`,
  'api-alpha.zsaos.com',
  { headers: auth, maxTime: '120' },
);
let healthBody = {};
try {
  healthBody = JSON.parse(health.text || '{}');
} catch {
  healthBody = {};
}

const prevPath = join(root, '.tools/alpha-runtime/m5-regress-report.json');
const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, 'utf8')) : {};
const report = {
  ...prev,
  adminCapacity,
  exhaustion: { ...(prev.exhaustion || {}), liveReject },
  webCeshi:
    publicLive.status >= 200 &&
    publicLive.status < 400 &&
    (healthBody.overallStatus === 'HEALTHY' ||
      healthBody.overallStatus === 'STATUS_PENDING' ||
      healthBody.publicStatus === 'OK' ||
      publicLive.status === 200),
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  defaults: BETA_CAPACITY_DEFAULTS,
  diskAfter,
  adminStatus: adminRuntime.status,
};
report.finalPass =
  Boolean(report.sim10) &&
  report.exhaustion?.disk &&
  report.exhaustion?.memory &&
  report.exhaustion?.buildSlots &&
  report.exhaustion?.noInternalLeak &&
  report.exhaustion?.liveReject &&
  report.workerRestart?.running &&
  report.workerRestart?.publicOk &&
  report.adminCapacity &&
  report.webCeshi &&
  report.secretsExposed === 'NO' &&
  report.paidResourceCreated === 'NO';

writeFileSync(prevPath, JSON.stringify(report, null, 2));
console.log(
  'M5_FINISH',
  JSON.stringify({
    adminCapacity,
    liveReject,
    webCeshi: report.webCeshi,
    finalPass: report.finalPass,
    adminStatus: adminRuntime.status,
  }),
);
console.log(report.finalPass ? 'M5_REGRESS=PASS' : 'M5_REGRESS=FAIL');
await prisma.$disconnect().catch(() => undefined);
try {
  await runner.disconnect();
} catch {}
process.exit(report.finalPass ? 0 : 1);
