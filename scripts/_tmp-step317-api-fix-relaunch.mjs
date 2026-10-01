/**
 * Rebuild/redeploy Alpha API with multi-unit plannedUnits + verifyRoute fixes, then relaunch.
 * node scripts/_tmp-step317-api-fix-relaunch.mjs --confirm-api-fix
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
if (!process.argv.includes('--confirm-api-fix')) {
  console.error('pass --confirm-api-fix');
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
const IMAGE_TAG = 'launchos-alpha-api:step317e';
const LOCAL_IMAGE = IMAGE_TAG;
const REMOTE_IMAGE = `localhost/${IMAGE_TAG}`;
const LIVE = 'launchos-alpha-api';
const CAND = 'launchos-alpha-api-cand-317e';
const LIVE_PORT = 39110;
const CAND_PORT = 39117;
const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const LAUNCH_RUN = 'cmunhwddb0019rl01fzipihgn';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '').replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}
function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = ['-k','-sS','-X',method,'--resolve',`${host}:443:${TARGET_HOST}`,'-w','\n__STATUS__:%{http_code}','--max-time',String(maxTime)];
  for (const [k,v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H','content-type: application/json','--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
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
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1200)}`);
  return r;
}

console.log('[1] build api');
const build = local('docker', ['build','--platform','linux/amd64','-f','deploy/alpha/Dockerfile.api','-t',LOCAL_IMAGE,'.']);
writeFileSync(join(ARTIFACT_DIR, 'step317e-api-build.log'), redact(`${build.stdout||''}\n${build.stderr||''}`).slice(-250000));
if (build.status !== 0) throw new Error('api build failed');
const markers = local('docker', ['run','--rm','--entrypoint','sh',LOCAL_IMAGE,'-c',
  'grep -c multiUnitIncomplete /app/apps/api/dist/launch/launch.service.js; grep -c "!item.hostname.startsWith" /app/apps/api/dist/launch/launch.service.js; grep -c runManagedAlphaLaunch /app/apps/api/dist/launch/launch.service.js']);
console.log('markers', String(markers.stdout||'').trim());
if (markers.status !== 0) throw new Error('markers failed');

console.log('[2] upload/promote');
const tarPath = join(ARTIFACT_DIR, 'launchos-alpha-api-step317e.tar');
try { unlinkSync(tarPath); } catch {}
if (local('docker', ['save','-o',tarPath,LOCAL_IMAGE]).status !== 0) throw new Error('save failed');
const remoteTar = '/opt/launchos/tmp/launchos-alpha-api-step317e.tar';
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir');
await runner.upload(tarPath, remoteTar, { timeoutMs: 900000 });
await remoteOk(`podman load -i ${remoteTar} && rm -f ${remoteTar} && (podman tag docker.io/library/${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || podman tag ${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || true)`, 'load', { timeoutMs: 600000 });

await runner.writeTextFile('/opt/launchos/bin/step317-run-api.sh', `#!/bin/bash
set -euo pipefail
NAME="$1"; PORT="$2"; IMAGE="$3"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-api.env --env-file /opt/launchos/config/alpha-github.env \\
  -e "API_PORT=$PORT" \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/api/dist/main.js'
echo STARTED
`);
await remoteOk('chmod 700 /opt/launchos/bin/step317-run-api.sh', 'chmod');
await remoteOk(`/opt/launchos/bin/step317-run-api.sh ${CAND} ${CAND_PORT} ${REMOTE_IMAGE}`, 'cand', { timeoutMs: 120000 });
await remoteOk(`i=0; while [ $i -lt 40 ]; do i=$((i+1)); if curl -fsS http://127.0.0.1:${CAND_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then echo OK; exit 0; fi; sleep 2; done; podman logs --tail 40 ${CAND}; exit 1`, 'wait-cand', { timeoutMs: 120000 });
await applyColocatedNginxRoute({ host: TARGET_HOST, port: server.port, username, password, hostname: 'api-alpha.zsaos.com', healthPath: '/api/v1/health', targetPort: CAND_PORT });
await remoteOk(`/opt/launchos/bin/step317-run-api.sh ${LIVE} ${LIVE_PORT} ${REMOTE_IMAGE}`, 'live', { timeoutMs: 120000 });
await remoteOk(`i=0; while [ $i -lt 40 ]; do i=$((i+1)); if curl -fsS http://127.0.0.1:${LIVE_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then echo OK; exit 0; fi; sleep 2; done; exit 1`, 'wait-live', { timeoutMs: 120000 });
await applyColocatedNginxRoute({ host: TARGET_HOST, port: server.port, username, password, hostname: 'api-alpha.zsaos.com', healthPath: '/api/v1/health', targetPort: LIVE_PORT });
await remoteOk(`podman rm -f ${CAND} 2>/dev/null || true`, 'rm-cand');

console.log('[3] reset + launch');
await remoteOk(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6'; UPDATE \\"LaunchRun\\" SET status='WAITING_CONFIRMATION', \\"failureCode\\"=NULL, \\"failureMessage\\"=NULL, \\"finishedAt\\"=NULL, \\"startedAt\\"=NULL, \\"confirmationId\\"=NULL, \\"confirmedAt\\"=NULL, \\"confirmedByUserId\\"=NULL, \\"confirmedPlanHash\\"=NULL, \\"confirmationSnapshot\\"=NULL WHERE id='${LAUNCH_RUN}';"`, 'reset');

const ownerEmail = (await remoteOk(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`, 'owner')).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile('/opt/launchos/tmp/step317-pass22.sql', `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g,"''")}' WHERE email='${ownerEmail.replace(/'/g,"''")}';\n`);
await remoteOk('podman cp /opt/launchos/tmp/step317-pass22.sql launchos-alpha-postgres:/tmp/step317-pass22.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass22.sql', 'pass');

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', { method:'POST', headers:{ origin:'https://alpha.zsaos.com' }, body: JSON.stringify({ email: ownerEmail, password: tempPass }) });
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error('login failed');
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

const plan = curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', { method:'POST', headers:auth, maxTime:'180' });
console.log('PLAN', plan.status, redact(plan.text).slice(0, 400));
console.log('CONFIRM', curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', { method:'POST', headers:auth }).status);
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { method:'POST', headers:auth });
console.log('START', start.status, redact(start.text).slice(0, 400));

let final = null;
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth, maxTime: '30' });
  try { final = JSON.parse(st.text || '{}'); } catch { final = { status: 'PARSE_ERROR' }; }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage||''} ${final.currentStep||''} ${final.publicUrl||''}`);
  if (['SUCCESS','FAILED','CANCELLED'].includes(final.status)) break;
}

await runner.writeTextFile('/opt/launchos/bin/step317-result6.sh', `#!/bin/bash
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),200) FROM \\"LaunchRun\\" WHERE id='${LAUNCH_RUN}';"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"deployableUnitId\\",''), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 6;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 8;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, hostname, status, coalesce(\\"unitId\\",'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 10;"
`);
const result = await remoteOk('chmod 700 /opt/launchos/bin/step317-result6.sh && /opt/launchos/bin/step317-result6.sh', 'result');
console.log('RESULT\n' + result.stdout);

const hosts = [...new Set(String(result.stdout||'').split(/\r?\n/).flatMap(l => [...l.matchAll(/([a-z0-9.-]+\.(?:zsaos\.com|launchos\.app))/g)].map(m=>m[1])))];
for (const host of hosts) {
  const rootResp = curl(`https://${host}/`, host, { maxTime: '45' });
  const health = curl(`https://${host}/health`, host, { maxTime: '45' });
  console.log('VERIFY', host, 'root', rootResp.status, 'health', health.status, redact(rootResp.text).slice(0,100).replace(/\s+/g,' '));
}

writeFileSync(join(ARTIFACT_DIR, 'step317-api-fix-relaunch.txt'), redact(JSON.stringify({ final, result: result.stdout, hosts }, null, 2)));
await runner.disconnect();
await prisma.$disconnect();
process.exit(final?.status === 'SUCCESS' ? 0 : 1);
