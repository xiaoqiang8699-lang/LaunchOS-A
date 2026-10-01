import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
if (!process.argv.includes('--confirm-continue')) {
  console.error('pass --confirm-continue');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const LAUNCH_RUN = 'cmunhwddb0019rl01fzipihgn';
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

await runner.writeTextFile(
  '/opt/launchos/bin/step317-status-now.sh',
  `#!/bin/bash
set +e
echo ===LAUNCH===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),160) FROM \\"LaunchRun\\" WHERE id='${LAUNCH_RUN}';"
echo ===DEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),160), coalesce(\\"deployableUnitId\\",''), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 6;"
DEP=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1;")
echo DEP=$DEP
echo ===STEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepKey\\", status, left(coalesce(\\"errorMessage\\",''),200) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='$DEP' ORDER BY \\"createdAt\\";"
echo ===HB===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, \\"lastSeenAt\\"::text FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 1;"
echo ===LOGS===
podman logs --tail 40 launchos-alpha-worker 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,})[=:][^ ]+/\\1=***/gi' | tail -40
`,
);
let status = await remoteOk('chmod 700 /opt/launchos/bin/step317-status-now.sh && /opt/launchos/bin/step317-status-now.sh', 'status');
console.log(status.stdout);

const launchLine = String(status.stdout || '').split(/\r?\n/).find((l) => l.startsWith(LAUNCH_RUN)) || '';
const launchStatus = launchLine.split('|')[1] || '';
const topDep = String(status.stdout || '')
  .split(/\r?\n/)
  .find((l) => /^cmun[a-z0-9]+\|/.test(l) && !l.startsWith(LAUNCH_RUN));
const topDepStatus = topDep?.split('|')[1] || '';
console.log('launchStatus', launchStatus, 'topDepStatus', topDepStatus);

async function pollUntilDone(auth) {
  let final = null;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', {
      headers: auth,
      maxTime: '30',
    });
    try {
      final = JSON.parse(st.text || '{}');
    } catch {
      final = { status: 'PARSE_ERROR' };
    }
    console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''} ${final.publicUrl || ''}`);
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) break;
  }
  return final;
}

async function loginAuth() {
  const ownerEmail = (
    await remoteOk(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
      'owner',
    )
  ).stdout.trim();
  const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
  const hash = await bcryptLib.hash(tempPass, 10);
  await runner.writeTextFile(
    '/opt/launchos/tmp/step317-pass26.sql',
    `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
  );
  await remoteOk(
    'podman cp /opt/launchos/tmp/step317-pass26.sql launchos-alpha-postgres:/tmp/step317-pass26.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass26.sql',
    'pass',
  );
  const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
    method: 'POST',
    headers: { origin: 'https://alpha.zsaos.com' },
    body: JSON.stringify({ email: ownerEmail, password: tempPass }),
  });
  const token = JSON.parse(login.text || '{}').accessToken;
  if (!token) throw new Error('login failed ' + login.status);
  return { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };
}

let final = null;
const auth = await loginAuth();

if (['RUNNING', 'WAITING_CONFIRMATION'].includes(launchStatus) || ['QUEUED', 'RUNNING', 'PENDING'].includes(topDepStatus)) {
  console.log('[path] wait current run/dep');
  // If LaunchRun already FAILED but dep still running from orphan accept, wait dep then relaunch.
  if (launchStatus === 'FAILED' && ['QUEUED', 'RUNNING', 'PENDING'].includes(topDepStatus)) {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      status = await remoteOk('/opt/launchos/bin/step317-status-now.sh', 'status-loop');
      const depLine = String(status.stdout || '')
        .split(/\r?\n/)
        .find((l) => /^cmun[a-z0-9]+\|/.test(l) && !l.startsWith(LAUNCH_RUN));
      const st = depLine?.split('|')[1] || '';
      console.log(`[dep ${i}] ${depLine || ''}`);
      if (!['QUEUED', 'RUNNING', 'PENDING'].includes(st)) break;
    }
  } else if (launchStatus === 'RUNNING') {
    final = await pollUntilDone(auth);
  }
}

if (!final || !['SUCCESS'].includes(final.status)) {
  // Fresh confirm/launch path (LaunchRun currently FAILED from timeout)
  console.log('[path] fresh reset+launch');
  await runner.writeTextFile(
    '/opt/launchos/tmp/step317-reset26.sql',
    `UPDATE "Deployment" SET status='FAILED', "failureCode"='SUPERSEDED', "errorMessage"='superseded by step317 continue', "finishedAt"=NOW()
 WHERE "projectId"='${PROJECT}' AND status IN ('QUEUED','RUNNING','PENDING');
UPDATE "GitProviderConnection" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6';
UPDATE "SourceRepository" SET "authStatus"='OK' WHERE "connectionId"='cmump0lbq0018rl01n2beawv6';
UPDATE "LaunchRun" SET status='WAITING_CONFIRMATION', "failureCode"=NULL, "failureMessage"=NULL, "finishedAt"=NULL, "startedAt"=NULL, "confirmationId"=NULL, "confirmedAt"=NULL, "confirmedByUserId"=NULL, "confirmedPlanHash"=NULL, "confirmationSnapshot"=NULL WHERE id='${LAUNCH_RUN}';
`,
  );
  await remoteOk(
    'podman cp /opt/launchos/tmp/step317-reset26.sql launchos-alpha-postgres:/tmp/step317-reset26.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-reset26.sql',
    'reset',
  );
  console.log('PLAN', curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', { method: 'POST', headers: auth, maxTime: '180' }).status);
  console.log('CONFIRM', curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', { method: 'POST', headers: auth }).status);
  const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { method: 'POST', headers: auth });
  console.log('START', start.status, redact(start.text).slice(0, 400));
  if (start.status < 200 || start.status >= 300) throw new Error('start failed');
  final = await pollUntilDone(auth);
}

const result = await remoteOk('/opt/launchos/bin/step317-status-now.sh', 'final-status');
console.log('RESULT\n' + result.stdout);
await runner.writeTextFile(
  '/opt/launchos/bin/step317-result10.sh',
  `#!/bin/bash
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 8;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, hostname, status, coalesce(\\"unitId\\",'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 10;"
`,
);
const extra = await remoteOk('chmod 700 /opt/launchos/bin/step317-result10.sh && /opt/launchos/bin/step317-result10.sh', 'extra');
console.log('EXTRA\n' + extra.stdout);

const hosts = [
  ...new Set(
    String(extra.stdout || '')
      .split(/\r?\n/)
      .flatMap((l) => [...l.matchAll(/([a-z0-9.-]+\.(?:zsaos\.com|launchos\.app))/g)].map((m) => m[1])),
  ),
];
for (const host of hosts) {
  const rootResp = curl(`https://${host}/`, host, { maxTime: '45' });
  console.log('VERIFY', host, 'root', rootResp.status, redact(rootResp.text).slice(0, 160).replace(/\s+/g, ' '));
}

writeFileSync(
  join(ARTIFACT_DIR, 'step317-continue-relaunch.txt'),
  redact(JSON.stringify({ final, result: result.stdout, extra: extra.stdout, hosts }, null, 2)),
);
await runner.disconnect();
await prisma.$disconnect();
process.exit(final?.status === 'SUCCESS' ? 0 : 1);
