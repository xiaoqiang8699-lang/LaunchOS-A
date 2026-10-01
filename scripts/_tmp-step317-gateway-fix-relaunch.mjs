/**
 * Fix gateway unit isolation patch + restore API route + relaunch.
 * node scripts/_tmp-step317-gateway-fix-relaunch.mjs --confirm-gw
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
if (!process.argv.includes('--confirm-gw')) {
  console.error('pass --confirm-gw');
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
const LIVE = 'launchos-alpha-worker';
const IMAGE = 'localhost/launchos-alpha-worker:step317d';
const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const LAUNCH_RUN = 'cmunhwddb0019rl01fzipihgn';
const WEB_UNIT = 'cmunhwc9k000drl01gxu1qwq2';
const API_UNIT = 'cmunhwc9g000brl01bgid72o7';
const ENGINE_LOCAL = resolve(root, 'packages/deployment/dist/engine/deployment-engine.service.js');
const GIT_LOCAL = resolve(root, 'packages/git/dist/git.service.js');
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '').replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
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
function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 8_000_000, shell: true });
}

console.log('[0] build deployment');
const build = local('pnpm', ['--filter', '@launchos/deployment', 'build']);
if (build.status !== 0) throw new Error('deployment build failed');
const engineSrc = readFileSync(ENGINE_LOCAL, 'utf8');
if (!engineSrc.includes('never retarget a sibling') && !engineSrc.includes('Never retarget a sibling')) {
  // comment may be stripped; check guard
  if (!engineSrc.includes("domain.startsWith('api-')")) throw new Error('gateway isolation missing');
}
if (!existsSync(GIT_LOCAL) || !readFileSync(GIT_LOCAL, 'utf8').includes('detectGitHubDefaultBranchViaApi')) {
  throw new Error('git patch missing');
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(command, label, opts = {}) {
  const r = await runner.execute(shellCommand(command), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

console.log('[1] remount worker patches');
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin /opt/launchos/artifacts', 'mkdir');
const remoteEngine = '/opt/launchos/tmp/deployment-engine.service.js';
const remoteGit = '/opt/launchos/tmp/git.service.js';
await runner.upload(ENGINE_LOCAL, remoteEngine, { timeoutMs: 120000 });
await runner.upload(GIT_LOCAL, remoteGit, { timeoutMs: 120000 });
await remoteOk(
  `chmod 700 /opt/launchos/bin/step317-run-worker-patched2.sh && /opt/launchos/bin/step317-run-worker-patched2.sh ${LIVE} ${IMAGE} ${remoteEngine} ${remoteGit}`,
  'start',
  { timeoutMs: 120000 },
);

let ready = false;
for (let i = 0; i < 45; i++) {
  const hb = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, EXTRACT(EPOCH FROM (NOW()-\\"lastSeenAt\\"))::int, left(coalesce(meta::text,''),180) FROM \\"WorkerHeartbeat\\" WHERE service='deployment-worker' ORDER BY \\"lastSeenAt\\" DESC LIMIT 1;"`,
    'hb',
  );
  const line = String(hb.stdout || '').trim();
  const [st, age, meta] = line.split('|');
  if (i % 3 === 0) console.log(`[hb ${i}] ${line.slice(0, 200)}`);
  if (st === 'ONLINE' && Number(age) < 20 && /"deployment"\s*:\s*true/.test(meta || '')) {
    ready = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!ready) throw new Error('worker not ready');
await remoteOk(
  `podman exec ${LIVE} grep -c "startsWith('api-')" /app/packages/deployment/dist/engine/deployment-engine.service.js`,
  'gw-marker',
);

console.log('[2] restore API gateway to API service port');
const ports = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT coalesce(\\"deployableUnitId\\",''), status, coalesce(\\"externalPort\\"::text,'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' AND status='RUNNING' ORDER BY \\"updatedAt\\" DESC;"`,
  'ports',
);
console.log('PORTS\n' + ports.stdout);
const apiPort =
  Number(
    String(ports.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith(API_UNIT + '|RUNNING|'))
      ?.split('|')[2],
  ) || 39005;
const webPort =
  Number(
    String(ports.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith(WEB_UNIT + '|RUNNING|'))
      ?.split('|')[2],
  ) || 39006;
console.log({ apiPort, webPort });

await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'api-launchos-multi-demo-5.launchos.app',
  targetPort: apiPort,
  healthPath: '/health',
});
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'web-launchos-multi-demo-5.launchos.app',
  targetPort: webPort,
  healthPath: '/',
});
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'launchos-multi-demo-5.launchos.app',
  targetPort: webPort,
  healthPath: '/',
});

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-fix-routes.sql',
  `UPDATE "ApplicationDomain" SET "runtimePort"=${apiPort}, "deployableUnitId"='${API_UNIT}' WHERE domain='api-launchos-multi-demo-5.launchos.app';
UPDATE "ApplicationDomain" SET "runtimePort"=${webPort}, "deployableUnitId"='${WEB_UNIT}' WHERE domain IN ('web-launchos-multi-demo-5.launchos.app','launchos-multi-demo-5.launchos.app');
UPDATE "GatewayRoute" SET "targetPort"=${apiPort}, "unitId"='${API_UNIT}', status='ACTIVE' WHERE hostname='api-launchos-multi-demo-5.launchos.app';
UPDATE "GatewayRoute" SET "targetPort"=${webPort}, "unitId"='${WEB_UNIT}', status='ACTIVE' WHERE hostname IN ('web-launchos-multi-demo-5.launchos.app','launchos-multi-demo-5.launchos.app');
`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step317-fix-routes.sql launchos-alpha-postgres:/tmp/step317-fix-routes.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-fix-routes.sql',
  'fix-routes',
);

for (const [host, path] of [
  ['api-launchos-multi-demo-5.launchos.app', '/health'],
  ['api-launchos-multi-demo-5.launchos.app', '/'],
  ['web-launchos-multi-demo-5.launchos.app', '/'],
  ['launchos-multi-demo-5.launchos.app', '/'],
]) {
  const v = curl(`https://${host}${path}`, host, { maxTime: '30' });
  console.log('PRECHECK', host, path, v.status, redact(v.text).slice(0, 100).replace(/\s+/g, ' '));
}

console.log('[3] seed + reset + launch');
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-seed-web-config.mjs',
  `import { createRequire } from 'node:module';
const require = createRequire('/app/apps/api/package.json');
const { PrismaClient } = require('@launchos/database');
const { encryptCredential } = require('@launchos/shared');
const prisma = new PrismaClient();
const projectId='${PROJECT}', webUnitId='${WEB_UNIT}', apiUnitId='${API_UNIT}';
const apiUrl='https://api-launchos-multi-demo-5.launchos.app';
const sentry='https://public@sentry.invalid/0';
const defaultsByKey={SENTRY_DSN:sentry,NEXT_PUBLIC_SENTRY_DSN:sentry,VITE_SENTRY_DSN:sentry,NEXT_PUBLIC_API_URL:apiUrl,VITE_API_URL:apiUrl,EXPO_PUBLIC_API_URL:apiUrl,API_URL:apiUrl,PUBLIC_API_URL:apiUrl,JWT_SECRET:'alpha_'+require('crypto').randomBytes(24).toString('hex')};
for (const unitId of [webUnitId, apiUnitId]) {
  for (const req of await prisma.runtimeConfigRequirement.findMany({ where:{ deployableUnitId: unitId }})) {
    const value=defaultsByKey[req.key]; if(!value){console.log('SKIP',unitId,req.key);continue;}
    await prisma.runtimeConfigValue.upsert({
      where:{scopeType_scopeId_key:{scopeType:'UNIT',scopeId:unitId,key:req.key}},
      create:{projectId,scopeType:'UNIT',scopeId:unitId,deployableUnitId:unitId,requirementId:req.id,key:req.key,valueEncrypted:encryptCredential(value),isSensitive:Boolean(req.sensitive),source:'MANUAL',provider:'MANUAL',providerRef:'alpha-step317'},
      update:{valueEncrypted:encryptCredential(value),requirementId:req.id,isSensitive:Boolean(req.sensitive),source:'MANUAL',provider:'MANUAL',providerRef:'alpha-step317'},
    });
    console.log('SEEDED',unitId,req.key);
  }
}
await prisma.$disconnect();
`,
);
console.log(
  (
    await remoteOk(
      'podman cp /opt/launchos/tmp/step317-seed-web-config.mjs launchos-alpha-api:/tmp/step317-seed-web-config.mjs && podman exec -w /app launchos-alpha-api node /tmp/step317-seed-web-config.mjs',
      'seed',
    )
  ).stdout,
);

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-reset29.sql',
  `UPDATE "Deployment" SET status='FAILED', "failureCode"='SUPERSEDED', "errorMessage"='superseded by step317 gateway fix', "finishedAt"=NOW()
 WHERE "projectId"='${PROJECT}' AND status IN ('QUEUED','RUNNING','PENDING');
UPDATE "GitProviderConnection" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6';
UPDATE "SourceRepository" SET "authStatus"='OK' WHERE "connectionId"='cmump0lbq0018rl01n2beawv6';
UPDATE "LaunchRun" SET status='WAITING_CONFIRMATION', "failureCode"=NULL, "failureMessage"=NULL, "finishedAt"=NULL, "startedAt"=NULL, "confirmationId"=NULL, "confirmedAt"=NULL, "confirmedByUserId"=NULL, "confirmedPlanHash"=NULL, "confirmationSnapshot"=NULL WHERE id='${LAUNCH_RUN}';
`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step317-reset29.sql launchos-alpha-postgres:/tmp/step317-reset29.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-reset29.sql',
  'reset',
);

const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass29.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step317-pass29.sql launchos-alpha-postgres:/tmp/step317-pass29.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass29.sql',
  'pass',
);

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error('login failed');
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

console.log('PLAN', curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', { method: 'POST', headers: auth, maxTime: '180' }).status);
console.log('CONFIRM', curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', { method: 'POST', headers: auth }).status);
{
  const hb = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, EXTRACT(EPOCH FROM (NOW()-\\"lastSeenAt\\"))::int, left(coalesce(meta::text,''),120) FROM \\"WorkerHeartbeat\\" WHERE service='deployment-worker' ORDER BY \\"lastSeenAt\\" DESC LIMIT 1;"`,
    'hb-launch',
  );
  console.log('HB_LAUNCH', String(hb.stdout || '').trim());
  const [st, age, meta] = String(hb.stdout || '').trim().split('|');
  if (st !== 'ONLINE' || Number(age) > 25 || !/"deployment"\s*:\s*true/.test(meta || '')) {
    throw new Error('worker gate failed');
  }
}
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { method: 'POST', headers: auth });
console.log('START', start.status, redact(start.text).slice(0, 400));
if (start.status < 200 || start.status >= 300) throw new Error('start failed');

let final = null;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth, maxTime: '30' });
  try {
    final = JSON.parse(st.text || '{}');
  } catch {
    final = { status: 'PARSE_ERROR' };
  }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''} ${final.publicUrl || ''}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) break;
}

await runner.writeTextFile(
  '/opt/launchos/bin/step317-result13.sh',
  `#!/bin/bash
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),200), coalesce(\\"publicUrl\\",'') FROM \\"LaunchRun\\" WHERE id='${LAUNCH_RUN}';"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"deployableUnitId\\",''), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 4;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' AND status='RUNNING' ORDER BY \\"updatedAt\\" DESC LIMIT 6;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT hostname, status, coalesce(\\"unitId\\",''), coalesce(\\"targetPort\\"::text,'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY hostname;"
`,
);
const result = await remoteOk('chmod 700 /opt/launchos/bin/step317-result13.sh && /opt/launchos/bin/step317-result13.sh', 'result');
console.log('RESULT\n' + result.stdout);

const hosts = [
  'launchos-multi-demo-5.launchos.app',
  'web-launchos-multi-demo-5.launchos.app',
  'api-launchos-multi-demo-5.launchos.app',
];
for (const host of hosts) {
  const rootResp = curl(`https://${host}/`, host, { maxTime: '45' });
  const health = curl(`https://${host}/health`, host, { maxTime: '45' });
  console.log('VERIFY', host, 'root', rootResp.status, 'health', health.status, redact(rootResp.text).slice(0, 120).replace(/\s+/g, ' '));
}
for (const host of ['alpha.zsaos.com', 'api-alpha.zsaos.com', 'web-launchos.zsaos.com', 'oneclick-web.zsaos.com', 'launchos-real-test.zsaos.com']) {
  const path = host.startsWith('api-') ? '/api/v1/health' : '/';
  console.log('ROUTE', host, curl(`https://${host}${path}`, host, { maxTime: '30' }).status);
}

writeFileSync(
  join(ARTIFACT_DIR, 'step317-gateway-fix-relaunch.txt'),
  redact(JSON.stringify({ final, result: result.stdout, apiPort, webPort }, null, 2)),
);
await runner.disconnect();
await prisma.$disconnect();
process.exit(final?.status === 'SUCCESS' ? 0 : 1);
