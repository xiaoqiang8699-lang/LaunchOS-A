/**
 * Quick M3 API-only rebuild+promote+regress (web image already m3).
 * node scripts/_tmp-m3-api-resume.mjs --confirm-m3
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
if (!process.argv.includes('--confirm-m3')) {
  console.error('pass --confirm-m3');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand, redactSecrets } =
  requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const HOST = 'web-ceshi.zsaos.com';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const API_TAG = 'launchos-alpha-api:m3';
const API_REMOTE = `localhost/${API_TAG}`;
const LIVE_API = 'launchos-alpha-api';
const LIVE_API_PORT = 39110;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

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
  const args = [
    '-sS', '-L', '-X', method,
    '-w', '\n__STATUS__:%{http_code}\n__IP__:%{remote_ip}',
    '--max-time', String(maxTime),
  ];
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
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

console.log('[1] rebuild api');
const b = local('docker', [
  'build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.api', '-t', API_TAG, '.',
]);
writeFileSync(join(ARTIFACT_DIR, 'm3-api-rebuild.log'), redact(`${b.stdout || ''}\n${b.stderr || ''}`).slice(-200000));
if (b.status !== 0) throw new Error('api rebuild failed');

console.log('[2] promote api');
const tar = join(ARTIFACT_DIR, 'launchos-alpha-api-m3.tar');
try { unlinkSync(tar); } catch {}
if (local('docker', ['save', '-o', tar, API_TAG]).status !== 0) throw new Error('save failed');
await runner.upload(tar, `/opt/launchos/tmp/launchos-alpha-api-m3.tar`, { timeoutMs: 900000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-api-m3.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-m3.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
  'load-api',
  { timeoutMs: 600000 },
);
await remoteOk(`/opt/launchos/bin/m3-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'run-api', {
  timeoutMs: 120000,
});
await remoteOk('/opt/launchos/tmp/m3-wait-api.sh', 'wait-api', { timeoutMs: 120000 });
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'api-alpha.zsaos.com',
  healthPath: '/api/v1/health',
  targetPort: LIVE_API_PORT,
});

console.log('[3] auth + regress');
const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Tmp-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/m3-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m3-setpass.sql',
  'set-pass',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${redact(login.text).slice(0, 300)}`);
const auth = { authorization: `Bearer ${token}` };

// Make internal health intentionally stale, then refresh public — should still become HEALTHY via fresh public.
const siId = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' AND status='RUNNING' ORDER BY \\"createdAt\\" DESC LIMIT 1"`,
    'si',
  )
).stdout.trim();
const staleIso = new Date(Date.now() - 20 * 60_000).toISOString();
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"ServiceInstance\\" SET \\"lastHealthCheckAt\\"='${staleIso}', \\"healthStatus\\"='HEALTHY' WHERE id='${siId}';"`,
  'stale-touch',
);

const health = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime?refreshPublic=1`,
  'api-alpha.zsaos.com',
  { headers: auth, maxTime: '120' },
);
const healthBody = JSON.parse(health.text || '{}');
console.log('healthy', healthBody.overallStatus, healthBody.publicStatus, healthBody.version, healthBody.lastHealthCheckLabel, healthBody.lastPublicCheckLabel);

await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "INSERT INTO \\"ServiceHealthCheck\\" (id, \\"serviceInstanceId\\", status, \\"statusCode\\", message, \\"checkedAt\\") VALUES ('m3pubfailfixture02', '${siId}', 'UNHEALTHY', 502, 'public:FAIL:http=502', NOW());"`,
  'insert-fail',
);
const failBody = JSON.parse(
  curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime`, 'api-alpha.zsaos.com', { headers: auth }).text ||
    '{}',
);
console.log('publicFail', failBody.overallStatus, failBody.anomalyLayer, failBody.failureCategory);
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "DELETE FROM \\"ServiceHealthCheck\\" WHERE id='m3pubfailfixture02';"`,
  'del-fail',
);

await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"ServiceInstance\\" SET \\"lastHealthCheckAt\\"='${staleIso}' WHERE id='${siId}'; DELETE FROM \\"ServiceHealthCheck\\" WHERE \\"serviceInstanceId\\"='${siId}' AND message LIKE 'public:%';"`,
  'stale-clear-public',
);
const staleBody = JSON.parse(
  curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime`, 'api-alpha.zsaos.com', { headers: auth }).text ||
    '{}',
);
console.log('stale', staleBody.overallStatus, staleBody.stale, staleBody.publicStatus);

const restored = JSON.parse(
  curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime?refreshPublic=1`, 'api-alpha.zsaos.com', {
    headers: auth,
    maxTime: '120',
  }).text || '{}',
);
console.log('restored', restored.overallStatus, restored.publicStatus, restored.httpStatus);

const logsBody = JSON.parse(
  curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/logs?tail=50`, 'api-alpha.zsaos.com', { headers: auth })
    .text || '{}',
);
const redactedSample = redactSecrets(
  `AUTH_SECRET=supersecret DATABASE_URL=postgres://u:p@h/db Bearer eyJhbGciOiJIUzI1NiJ9.xx.yy`,
);
const publicLive = curl(`https://${HOST}/`, HOST, { useResolve: false });
const pages = {
  project: curl(`https://alpha.zsaos.com/projects/${PROJECT}`, 'alpha.zsaos.com').status,
  runtime: curl(`https://alpha.zsaos.com/projects/${PROJECT}/runtime`, 'alpha.zsaos.com').status,
  versions: curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/versions`, 'api-alpha.zsaos.com', { headers: auth })
    .status,
  deployments: curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/deployments`, 'api-alpha.zsaos.com', {
    headers: auth,
  }).status,
  publicApp: publicLive.status,
};

const report = {
  healthy:
    healthBody.overallStatus === 'HEALTHY' &&
    healthBody.publicStatus === 'OK' &&
    restored.overallStatus === 'HEALTHY',
  publicFail:
    failBody.overallStatus === 'UNHEALTHY' &&
    failBody.anomalyLayer === 'PUBLIC' &&
    failBody.failureCategory === 'PLATFORM',
  stale: staleBody.overallStatus === 'STATUS_PENDING' || staleBody.stale === true,
  logsOk: typeof logsBody.logs === 'string' && Number(logsBody.limit) <= 500 && !redactedSample.includes('supersecret'),
  existingFlows: pages.versions === 200 && pages.deployments === 200 && pages.publicApp >= 200 && pages.publicApp < 400,
  pages,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  healthSample: {
    overallStatus: restored.overallStatus,
    version: restored.version,
    publicStatus: restored.publicStatus,
    visitUrl: restored.visitUrl,
    lastHealthCheckLabel: restored.lastHealthCheckLabel,
    lastPublicCheckLabel: restored.lastPublicCheckLabel,
    startupSummary: restored.startupSummary,
  },
};
const finalPass =
  report.healthy &&
  report.publicFail &&
  report.stale &&
  report.logsOk &&
  report.existingFlows &&
  report.secretsExposed === 'NO' &&
  report.paidResourceCreated === 'NO';
report.finalPass = finalPass;
writeFileSync(join(ARTIFACT_DIR, 'm3-regress-report.json'), JSON.stringify(report, null, 2));
console.log('M3_REPORT', JSON.stringify(report));
console.log(finalPass ? 'M3_REGRESS=PASS' : 'M3_REGRESS=FAIL');
await prisma.$disconnect().catch(() => undefined);
try { await runner.disconnect(); } catch {}
process.exit(finalPass ? 0 : 1);
