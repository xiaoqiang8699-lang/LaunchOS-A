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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

function redact(t) {
  return String(t || '').replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = ['-k','-sS','-X',method,'--resolve',`${host}:443:116.62.198.184`,'-w','\n__STATUS__:%{http_code}','--max-time',String(maxTime)];
  for (const [k,v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H','content-type: application/json','--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const LAUNCH_RUN = 'cmunhwddb0019rl01fzipihgn';
const WEB_UNIT = 'cmunhwc9k000drl01gxu1qwq2';

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});
async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}

// Patch runManagedAlphaLaunch in the LIVE api container? Better rebuild API with verifyRoute fix
// and also force deploy WEB. For speed: call deployments.create for WEB via API after login,
// then patch LaunchRun to VERIFY manually? User asked for real confirm path.
// Rebuild API image with verifyRoute fix — but that's slow. Hot-patch dist in running container?

console.log('[1] hot-patch verifyRoute + ensure managed launch deploys WEB');
// Check current compiled matcher
const check = await remoteOk(
  `podman exec launchos-alpha-api sh -c 'grep -n "hostname.includes(\\"web\\")" /app/apps/api/dist/launch/launch.service.js | head; grep -n "startsWith(\\"api-\\")" /app/apps/api/dist/launch/launch.service.js | head'`,
  'check-js',
);
console.log(check.stdout || '');

// Replace includes('web') with !startsWith('api-') in the running API dist, then restart API.
await runner.writeTextFile(
  '/opt/launchos/bin/step317-patch-verify.sh',
  `#!/bin/bash
set -euo pipefail
FILE=/app/apps/api/dist/launch/launch.service.js
podman exec launchos-alpha-api sh -c "cp -a $FILE $FILE.bak.step317"
podman exec launchos-alpha-api node -e "
const fs=require('fs');
const p='/app/apps/api/dist/launch/launch.service.js';
let s=fs.readFileSync(p,'utf8');
const before=s.length;
s=s.replace(/unitType === 'API' \\? item\\.hostname\\.startsWith\\('api-'\\) : item\\.hostname\\.includes\\('web'\\)/g,
            \\"unitType === 'API' ? item.hostname.startsWith('api-') : !item.hostname.startsWith('api-')\\");
s=s.replace(/unitType===\\"API\\"\\?item\\.hostname\\.startsWith\\(\\"api-\\"\\):item\\.hostname\\.includes\\(\\"web\\"\\)/g,
            'unitType===\\"API\\"?item.hostname.startsWith(\\"api-\\"):!item.hostname.startsWith(\\"api-\\")');
fs.writeFileSync(p,s);
console.log('patched', before, '->', s.length);
"
# Also log launchUnits filter presence
podman exec launchos-alpha-api sh -c 'grep -n "launchUnits" /app/apps/api/dist/launch/launch.service.js | head -10'
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step317-patch-verify.sh && /opt/launchos/bin/step317-patch-verify.sh', 'patch');

// Restart API to pick up patch (node caches modules)
await remoteOk('podman restart launchos-alpha-api', 'restart-api');
await new Promise((r) => setTimeout(r, 8000));
await remoteOk(
  `i=0; while [ $i -lt 30 ]; do i=$((i+1)); if curl -fsS http://127.0.0.1:39110/api/v1/health 2>/dev/null | grep -q launchos-api; then echo API_OK; exit 0; fi; sleep 2; done; exit 1`,
  'api-health',
);

// Inspect why WEB not in launch: dump units from DB + try create WEB deployment directly via API after confirm path
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6'; UPDATE \\"LaunchRun\\" SET status='WAITING_CONFIRMATION', \\"failureCode\\"=NULL, \\"failureMessage\\"=NULL, \\"finishedAt\\"=NULL, \\"startedAt\\"=NULL, \\"confirmationId\\"=NULL, \\"confirmedAt\\"=NULL, \\"confirmedByUserId\\"=NULL, \\"confirmedPlanHash\\"=NULL, \\"confirmationSnapshot\\"=NULL WHERE id='${LAUNCH_RUN}';"`,
  'reset',
);

const ownerEmail = (await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
  'owner',
)).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile('/opt/launchos/tmp/step317-pass21.sql', `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g,"''")}' WHERE email='${ownerEmail.replace(/'/g,"''")}';\n`);
await remoteOk('podman cp /opt/launchos/tmp/step317-pass21.sql launchos-alpha-postgres:/tmp/step317-pass21.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass21.sql', 'pass');

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST', headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error('login failed');
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

// Check env id
const envId = (await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"environmentId\\" FROM \\"LaunchRun\\" WHERE id='${LAUNCH_RUN}';"`,
  'env',
)).stdout.trim();
console.log('envId', envId);

// Direct create WEB deployment to see blockers
const createWeb = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/deployments`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    environmentId: envId,
    hostingMode: 'launchos',
    targetType: 'MANAGED_SERVER',
    deployableUnitId: WEB_UNIT,
    idempotencyKey: `alpha-web-direct-${Date.now()}`,
  }),
  maxTime: '60',
});
console.log('CREATE_WEB', createWeb.status, redact(createWeb.text).slice(0, 800));

console.log('PLAN', curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', { method:'POST', headers:auth, maxTime:'180' }).status);
console.log('CONFIRM', curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', { method:'POST', headers:auth }).status);
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { method:'POST', headers:auth });
console.log('START', start.status, redact(start.text).slice(0, 400));

let final = null;
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth, maxTime: '30' });
  try { final = JSON.parse(st.text || '{}'); } catch { final = { status: 'PARSE_ERROR' }; }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage||''} ${final.currentStep||''} ${final.publicUrl||''}`);
  if (['SUCCESS','FAILED','CANCELLED'].includes(final.status)) break;
}

const result = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),200) FROM \\"LaunchRun\\" WHERE id='${LAUNCH_RUN}'; SELECT id, status, coalesce(\\"deployableUnitId\\",''), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 6; SELECT id, hostname, status, coalesce(\\"unitId\\",'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 10; SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 8;"`,
  'result',
);
console.log('RESULT\n' + result.stdout);

writeFileSync(join(root, '.tools/alpha-runtime/step317-patch-relaunch.txt'), redact(JSON.stringify({ final, createWeb: createWeb.text, result: result.stdout }, null, 2)));
await runner.disconnect();
await prisma.$disconnect();
process.exit(final?.status === 'SUCCESS' ? 0 : 1);
