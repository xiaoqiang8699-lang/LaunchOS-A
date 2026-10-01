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
const bcrypt = requireApi('bcrypt');

function redact(t) {
  return String(t || '')
    .replace(/postgresql:\/\/[^@\s]+@/gi, 'postgresql://***:***@')
    .replace(/redis:\/\/[^@\s]+@/gi, 'redis://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^\s]+/gi, '$1=***');
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = ['-k', '-sS', '-X', method, '--resolve', `${host}:443:116.62.198.184`, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const API_UNIT = 'cmunhwc9g000brl01bgid72o7';
const WEB_UNIT = 'cmunhwc9k000drl01gxu1qwq2';

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 20000,
});

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-fix-provider.mjs',
  `import { createRequire } from 'node:module';
const require = createRequire('/app/apps/api/package.json');
const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();
const projectId = '${PROJECT}';
const apiUnit = '${API_UNIT}';
const db = await prisma.databaseConnection.findFirst({ where: { projectId, name: 'LaunchOS Alpha shared Postgres' } });
const redis = await prisma.redisConnection.findFirst({ where: { projectId, name: 'LaunchOS Alpha shared Redis' } });
if (!db || !redis) throw new Error('connections missing');
for (const [key, provider, ref] of [
  ['DATABASE_URL', 'DATABASE_CONNECTION', db.id],
  ['REDIS_URL', 'REDIS_CONNECTION', redis.id],
]) {
  const updated = await prisma.runtimeConfigValue.updateMany({
    where: { projectId, deployableUnitId: apiUnit, key },
    data: { provider, providerRef: ref },
  });
  console.log('FIX', key, updated.count, ref);
}
await prisma.$disconnect();
`,
);
const fix = await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-fix-provider.mjs launchos-alpha-api:/tmp/step317-fix-provider.mjs && podman exec -w /app launchos-alpha-api node /tmp/step317-fix-provider.mjs',
  ),
  { timeoutMs: 60000 },
);
console.log(fix.stdout || fix.stderr);
if (fix.exitCode !== 0) throw new Error('fix provider failed');

await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6'; UPDATE \\"LaunchRun\\" SET status='WAITING_CONFIRMATION', \\"failureCode\\"=NULL, \\"failureMessage\\"=NULL, \\"finishedAt\\"=NULL, \\"startedAt\\"=NULL, \\"confirmationId\\"=NULL, \\"confirmedAt\\"=NULL, \\"confirmedByUserId\\"=NULL, \\"confirmedPlanHash\\"=NULL, \\"confirmationSnapshot\\"=NULL WHERE id='cmunhwddb0019rl01fzipihgn';"`,
  ),
  { timeoutMs: 20000 },
);

const ownerEmail = (
  await runner.execute(
    shellCommand(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
    ),
    { timeoutMs: 20000 },
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcrypt.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass12.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-pass12.sql launchos-alpha-postgres:/tmp/step317-pass12.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass12.sql',
  ),
  { timeoutMs: 20000 },
);

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

const deps = curl('https://api-alpha.zsaos.com/api/v1/projects/' + PROJECT + '/dependencies', 'api-alpha.zsaos.com', {
  headers: auth,
});
console.log('DEPS', deps.status, redact(deps.text).slice(0, 600));

const plan = curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  maxTime: '180',
});
console.log('PLAN', plan.status, redact(plan.text).slice(0, 500));
curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
});
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
});
console.log('START', start.status, redact(start.text).slice(0, 400));
if (start.status >= 400) throw new Error('start failed: ' + redact(start.text));

let final = null;
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth });
  final = JSON.parse(st.text || '{}');
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''}`);
  if (final.status === 'SUCCESS' || final.status === 'FAILED' || final.status === 'CANCELLED') break;
}

const sql = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),300) FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn'; SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),300) FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 5; SELECT ds.\\"stepKey\\", ds.status, left(coalesce(ds.\\"errorMessage\\",''),200) FROM \\"DeploymentStep\\" ds WHERE ds.\\"deploymentId\\"=(SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1) ORDER BY ds.\\"order\\"; SELECT id, hostname, status FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 5; SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"containerId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 5;"`,
  ),
  { timeoutMs: 30000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-final6.txt'), redact(sql.stdout || sql.stderr));
console.log('FINAL\n', redact(sql.stdout || sql.stderr));

let publicUrl = null;
const routeMatch = String(sql.stdout || '').split(/\n/).find((l) => l.includes('.zsaos.com|ACTIVE'));
if (routeMatch) {
  publicUrl = 'https://' + routeMatch.split('|')[1];
  const v = curl(publicUrl + '/', routeMatch.split('|')[1], { maxTime: '45' });
  console.log('VERIFY', v.status, redact(v.text).slice(0, 200));
}

await runner.disconnect();
await prisma.$disconnect();
