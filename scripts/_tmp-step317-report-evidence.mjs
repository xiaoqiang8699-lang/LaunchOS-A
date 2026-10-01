import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const { randomBytes } = await import('node:crypto');

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '60' } = opts;
  const args = ['-k','-sS','-X',method,'--resolve',`${host}:443:116.62.198.184`,'-w','\n__STATUS__:%{http_code}','--max-time',String(maxTime)];
  for (const [k,v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H','content-type: application/json','--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 4_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});
async function remoteOk(cmd) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: 90000 });
  return r.stdout || r.stderr || '';
}

const evidence = await remoteOk(`#!/bin/bash
# use inline
true
`);

const script = `#!/bin/bash
set +e
echo ===SERVER===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, host, scope, status, coalesce(\\"workspaceId\\",''), coalesce(\\"region\\",'') FROM \\"ServerInstance\\" WHERE host='116.62.198.184';"
echo ===HB===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, \\"lastSeenAt\\"::text, left(coalesce(meta::text,''),220) FROM \\"WorkerHeartbeat\\" WHERE service='deployment-worker' ORDER BY \\"lastSeenAt\\" DESC LIMIT 1;"
echo ===SI_COUNT===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT count(*) FROM \\"ServiceInstance\\" WHERE status='RUNNING';"
echo ===PLAN_SNAP===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT left(coalesce(\\"planSnapshot\\"::text,''),1200) FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn';"
echo ===LAUNCH===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"confirmationId\\",'') FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn';"
echo ===DEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"deployableUnitId\\",'') FROM \\"Deployment\\" WHERE id IN ('cmunpqqr300azrl019os3w0bj','cmunpl9se00adrl01c0k4udhc');"
echo ===SI===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' AND status='RUNNING';"
echo ===GR===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT hostname, status, coalesce(\\"targetPort\\"::text,''), coalesce(\\"unitId\\",'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY hostname;"
`;
await runner.writeTextFile('/opt/launchos/bin/step317-report-ev.sh', script);
const out = await remoteOk('chmod 700 /opt/launchos/bin/step317-report-ev.sh && /opt/launchos/bin/step317-report-ev.sh');
console.log(out);

// plan probe
const ownerEmail = (await remoteOk(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='cmunhwais0003rl01wqj1qy11';"`)).trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile('/opt/launchos/tmp/step317-pass-report.sql', `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g,"''")}' WHERE email='${ownerEmail.replace(/'/g,"''")}';\n`);
await remoteOk('podman cp /opt/launchos/tmp/step317-pass-report.sql launchos-alpha-postgres:/tmp/step317-pass-report.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass-report.sql');
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', { method:'POST', headers:{origin:'https://alpha.zsaos.com'}, body: JSON.stringify({email:ownerEmail,password:tempPass})});
const token = JSON.parse(login.text||'{}').accessToken;
const auth = { authorization:`Bearer ${token}`, origin:'https://alpha.zsaos.com' };
const plan = curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', { method:'POST', headers:auth, maxTime:'180' });
let planJson = {};
try { planJson = JSON.parse(plan.text||'{}'); } catch {}
const planSummary = {
  status: plan.status,
  canLaunch: planJson.canLaunch ?? planJson.plan?.canLaunch,
  billable: planJson.billableActions ?? planJson.plan?.billableActions,
  resourcesToCreate: planJson.resourcesToCreate ?? planJson.plan?.resourcesToCreate,
  platformManaged: planJson.platformManagedRuntime ?? planJson.planSnapshot?.platformManagedRuntime,
  messageZh: planJson.messageZh,
};
console.log('PLAN_NOW', JSON.stringify(planSummary).slice(0,800));

writeFileSync(join(root, '.tools/alpha-runtime/step317-report-evidence.txt'), out + '\nPLAN_NOW=' + JSON.stringify(planSummary,null,2));
await runner.disconnect();
await prisma.$disconnect();
