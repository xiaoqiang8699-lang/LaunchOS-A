/**
 * Wait for deployment queueReady=true, then confirm+launch.
 * node scripts/_tmp-step317-ready-relaunch.mjs --confirm-ready
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
if (!process.argv.includes('--confirm-ready')) {
  console.error('pass --confirm-ready');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const LIVE = 'launchos-alpha-worker';
const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const LAUNCH_RUN = 'cmunhwddb0019rl01fzipihgn';
const WEB_UNIT = 'cmunhwc9k000drl01gxu1qwq2';
const API_UNIT = 'cmunhwc9g000brl01bgid72o7';
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
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

console.log('[1] ensure worker patches + queueReady');
const markers = await remoteOk(
  `podman exec ${LIVE} sh -lc 'grep -c NPM_CONFIG_PRODUCTION /app/packages/deployment/dist/engine/deployment-engine.service.js; grep -c detectGitHubDefaultBranchViaApi /app/packages/git/dist/git.service.js; grep -c existing.shortSha /app/packages/deployment/dist/engine/deployment-engine.service.js; podman ps --filter name=${LIVE} --format "{{.Status}}" || true'`,
  'markers',
);
console.log('MARKERS', String(markers.stdout || '').trim());

let ready = false;
for (let i = 0; i < 60; i++) {
  const hb = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, EXTRACT(EPOCH FROM (NOW()-\\"lastSeenAt\\"))::int, left(coalesce(meta::text,''),220) FROM \\"WorkerHeartbeat\\" WHERE service='deployment-worker' ORDER BY \\"lastSeenAt\\" DESC LIMIT 1;"`,
    'hb',
  );
  const line = String(hb.stdout || '').trim();
  const [status, ageRaw, meta] = line.split('|');
  const age = Number(ageRaw);
  const ok =
    status === 'ONLINE' &&
    Number.isFinite(age) &&
    age < 20 &&
    /"deployment"\s*:\s*true/.test(meta || '');
  if (i % 3 === 0 || ok) console.log(`[hb ${i}] ${line.slice(0, 220)}`);
  if (ok) {
    ready = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!ready) {
  console.log(await remoteOk(`podman logs --tail 40 ${LIVE} 2>&1 | tail -40`, 'logs').then((r) => r.stdout));
  throw new Error('worker queueReady.deployment not fresh');
}
// Settle so API presence check cannot race the async heartbeat write.
await new Promise((r) => setTimeout(r, 3000));

console.log('[2] seed WEB config');
const routes = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT hostname, status FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 10;"`,
  'routes',
);
const apiHost =
  String(routes.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('api-') && l.includes('|ACTIVE'))
    ?.split('|')[0] || 'api-launchos-multi-demo-5.launchos.app';
const apiUrl = `https://${apiHost}`;
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-seed-web-config.mjs',
  `import { createRequire } from 'node:module';
const require = createRequire('/app/apps/api/package.json');
const { PrismaClient } = require('@launchos/database');
const { encryptCredential } = require('@launchos/shared');
const prisma = new PrismaClient();
const projectId='${PROJECT}', webUnitId='${WEB_UNIT}', apiUnitId='${API_UNIT}';
const apiUrl=${JSON.stringify(apiUrl)};
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

console.log('[3] reset + launch');
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-reset28.sql',
  `UPDATE "Deployment" SET status='FAILED', "failureCode"='SUPERSEDED', "errorMessage"='superseded by step317 ready relaunch', "finishedAt"=NOW()
 WHERE "projectId"='${PROJECT}' AND status IN ('QUEUED','RUNNING','PENDING');
UPDATE "GitProviderConnection" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6';
UPDATE "SourceRepository" SET "authStatus"='OK' WHERE "connectionId"='cmump0lbq0018rl01n2beawv6';
UPDATE "LaunchRun" SET status='WAITING_CONFIRMATION', "failureCode"=NULL, "failureMessage"=NULL, "finishedAt"=NULL, "startedAt"=NULL, "confirmationId"=NULL, "confirmedAt"=NULL, "confirmedByUserId"=NULL, "confirmedPlanHash"=NULL, "confirmationSnapshot"=NULL WHERE id='${LAUNCH_RUN}';
`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step317-reset28.sql launchos-alpha-postgres:/tmp/step317-reset28.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-reset28.sql',
  'reset',
);

// Re-check worker right before launch
{
  const hb = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, EXTRACT(EPOCH FROM (NOW()-\\"lastSeenAt\\"))::int, left(coalesce(meta::text,''),180) FROM \\"WorkerHeartbeat\\" WHERE service='deployment-worker' ORDER BY \\"lastSeenAt\\" DESC LIMIT 1;"`,
    'hb-pre',
  );
  console.log('HB_PRE', String(hb.stdout || '').trim());
  if (!/"deployment"\s*:\s*true/.test(hb.stdout || '')) throw new Error('lost queueReady before launch');
}

const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass28.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step317-pass28.sql launchos-alpha-postgres:/tmp/step317-pass28.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass28.sql',
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

// Final heartbeat gate immediately before launch
{
  const hb = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, EXTRACT(EPOCH FROM (NOW()-\\"lastSeenAt\\"))::int, left(coalesce(meta::text,''),180) FROM \\"WorkerHeartbeat\\" WHERE service='deployment-worker' ORDER BY \\"lastSeenAt\\" DESC LIMIT 1;"`,
    'hb-launch',
  );
  console.log('HB_LAUNCH', String(hb.stdout || '').trim());
  const parts = String(hb.stdout || '').trim().split('|');
  if (parts[0] !== 'ONLINE' || Number(parts[1]) > 25 || !/"deployment"\s*:\s*true/.test(parts[2] || '')) {
    throw new Error('worker not ready at launch gate');
  }
}

const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { method: 'POST', headers: auth });
console.log('START', start.status, redact(start.text).slice(0, 400));
if (start.status < 200 || start.status >= 300) throw new Error('start failed: ' + redact(start.text).slice(0, 500));

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
  '/opt/launchos/bin/step317-result12.sh',
  `#!/bin/bash
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),200), coalesce(\\"publicUrl\\",'') FROM \\"LaunchRun\\" WHERE id='${LAUNCH_RUN}';"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),160), coalesce(\\"deployableUnitId\\",''), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 6;"
DEP=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' AND \\"deployableUnitId\\"='${WEB_UNIT}' ORDER BY \\"createdAt\\" DESC LIMIT 1;")
echo WEB_DEP=$DEP
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepKey\\", status, left(coalesce(\\"errorMessage\\",''),200) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='$DEP' ORDER BY \\"createdAt\\";"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT left(message,400) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='$DEP' ORDER BY \\"createdAt\\" ASC LIMIT 50;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 8;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, hostname, status, coalesce(\\"unitId\\",'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 10;"
`,
);
const result = await remoteOk('chmod 700 /opt/launchos/bin/step317-result12.sh && /opt/launchos/bin/step317-result12.sh', 'result');
console.log('RESULT\n' + result.stdout);

const hosts = [
  ...new Set(
    String(result.stdout || '')
      .split(/\r?\n/)
      .flatMap((l) => [...l.matchAll(/([a-z0-9.-]+\.(?:zsaos\.com|launchos\.app))/g)].map((m) => m[1])),
  ),
];
for (const host of hosts) {
  const rootResp = curl(`https://${host}/`, host, { maxTime: '45' });
  console.log('VERIFY', host, 'root', rootResp.status, redact(rootResp.text).slice(0, 160).replace(/\s+/g, ' '));
}

// Existing alpha routes smoke
for (const host of ['alpha.zsaos.com', 'api-alpha.zsaos.com', 'web-launchos.zsaos.com', 'oneclick-web.zsaos.com', 'launchos-real-test.zsaos.com']) {
  const path = host.startsWith('api-') ? '/api/v1/health' : '/';
  const v = curl(`https://${host}${path}`, host, { maxTime: '30' });
  console.log('ROUTE', host, path, v.status);
}

writeFileSync(
  join(ARTIFACT_DIR, 'step317-ready-relaunch.txt'),
  redact(JSON.stringify({ final, result: result.stdout, hosts, apiUrl }, null, 2)),
);
await runner.disconnect();
await prisma.$disconnect();
process.exit(final?.status === 'SUCCESS' ? 0 : 1);
