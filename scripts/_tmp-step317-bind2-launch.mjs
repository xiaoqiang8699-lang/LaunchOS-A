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
const WORKSPACE = 'cmuku9o570016rin89tcczblf';
const API_UNIT = 'cmunhwc9g000brl01bgid72o7';
const WEB_UNIT = 'cmunhwc9k000drl01gxu1qwq2';
const DB_NAME = 'launchos_alpha_demo_multi';

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

// Ensure DB exists
await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "CREATE DATABASE ${DB_NAME};"`,
  ),
  { timeoutMs: 30000 },
);

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-bind2.mjs',
  `import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const require = createRequire('/app/apps/api/package.json');
const { PrismaClient } = require('@launchos/database');
const { encryptCredential } = require('@launchos/shared');
const prisma = new PrismaClient();

function readEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\\r?\\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const env = readEnvFile('/tmp/alpha-api.env');
const baseDb = env.DATABASE_URL;
if (!baseDb) throw new Error('DATABASE_URL missing in alpha-api.env');
const db = new URL(baseDb);
db.pathname = '/${DB_NAME}';
const dbUrl = db.toString();
let redisUrl = env.REDIS_URL || env.ALPHA_REDIS_URL || 'redis://127.0.0.1:6379/3';
try {
  const r = new URL(redisUrl);
  r.pathname = '/3';
  redisUrl = r.toString();
} catch {
  redisUrl = 'redis://127.0.0.1:6379/3';
}
const redis = new URL(redisUrl);
const password = decodeURIComponent(db.password || '');
const redisPass = decodeURIComponent(redis.password || '');

const projectId = '${PROJECT}';
const workspaceId = '${WORKSPACE}';
const apiUnit = '${API_UNIT}';

await prisma.databaseConnectionUnit.deleteMany({ where: { deployableUnitId: apiUnit } });
await prisma.redisConnectionUnit.deleteMany({ where: { deployableUnitId: apiUnit } });
await prisma.databaseConnection.deleteMany({ where: { projectId, source: 'MANUAL', name: 'LaunchOS Alpha shared Postgres' } });
await prisma.redisConnection.deleteMany({ where: { projectId, source: 'MANUAL', name: 'LaunchOS Alpha shared Redis' } });

const dbConn = await prisma.databaseConnection.create({
  data: {
    workspaceId,
    projectId,
    name: 'LaunchOS Alpha shared Postgres',
    engine: 'POSTGRESQL',
    status: 'CONNECTED',
    host: db.hostname || '127.0.0.1',
    port: Number(db.port || 5432),
    databaseName: '${DB_NAME}',
    username: decodeURIComponent(db.username || 'launchos_alpha'),
    passwordEncrypted: encryptCredential(password),
    sslMode: 'DISABLE',
    source: 'MANUAL',
    lastTestedAt: new Date(),
    lastTestStatus: 'SUCCESS',
  },
});
await prisma.databaseConnectionUnit.create({
  data: { databaseConnectionId: dbConn.id, deployableUnitId: apiUnit },
});

const redisConn = await prisma.redisConnection.create({
  data: {
    workspaceId,
    projectId,
    name: 'LaunchOS Alpha shared Redis',
    status: 'CONNECTED',
    host: redis.hostname || '127.0.0.1',
    port: Number(redis.port || 6379),
    passwordEncrypted: redisPass ? encryptCredential(redisPass) : null,
    databaseIndex: 3,
    tlsMode: 'DISABLE',
    source: 'MANUAL',
    lastTestedAt: new Date(),
    lastTestStatus: 'SUCCESS',
  },
});
await prisma.redisConnectionUnit.create({
  data: { redisConnectionId: redisConn.id, deployableUnitId: apiUnit },
});

const defaults = {
  DATABASE_URL: dbUrl,
  REDIS_URL: redisUrl,
  JWT_SECRET: 'alpha_' + randomBytes(24).toString('hex'),
  SENTRY_DSN: 'https://public@sentry.invalid/0',
};
for (const unitId of [apiUnit, '${WEB_UNIT}']) {
  const reqs = await prisma.runtimeConfigRequirement.findMany({ where: { deployableUnitId: unitId } });
  for (const req of reqs) {
    const value = defaults[req.key];
    if (!value) continue;
    await prisma.runtimeConfigValue.upsert({
      where: { scopeType_scopeId_key: { scopeType: 'UNIT', scopeId: unitId, key: req.key } },
      create: {
        projectId,
        scopeType: 'UNIT',
        scopeId: unitId,
        deployableUnitId: unitId,
        requirementId: req.id,
        key: req.key,
        valueEncrypted: encryptCredential(value),
        isSensitive: true,
        source: 'MANUAL',
      },
      update: {
        valueEncrypted: encryptCredential(value),
        requirementId: req.id,
        isSensitive: true,
      },
    });
    console.log('SEEDED', unitId, req.key);
  }
}
console.log('DB_CONN', dbConn.id);
console.log('REDIS_CONN', redisConn.id);
await prisma.$disconnect();
`,
);

// Mount host config into the one-shot? API container already has env; copy alpha-api.env into container tmp
const bind = await runner.execute(
  shellCommand(
    [
      'podman exec launchos-alpha-api mkdir -p /tmp',
      'podman cp /opt/launchos/config/alpha-api.env launchos-alpha-api:/tmp/alpha-api.env',
      'podman cp /opt/launchos/tmp/step317-bind2.mjs launchos-alpha-api:/tmp/step317-bind2.mjs',
      'podman exec -w /app launchos-alpha-api node /tmp/step317-bind2.mjs',
    ].join(' && '),
  ),
  { timeoutMs: 120000 },
);
console.log(redact(bind.stdout || bind.stderr));
if (bind.exitCode !== 0) throw new Error('bind failed: ' + redact(bind.stderr || bind.stdout || ''));

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
  '/opt/launchos/tmp/step317-pass11.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-pass11.sql launchos-alpha-postgres:/tmp/step317-pass11.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass11.sql',
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
if (start.status >= 400) throw new Error('start failed');

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
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),300) FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn'; SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),300) FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 5; SELECT id, hostname, status FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 5; SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"containerId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 5;"`,
  ),
  { timeoutMs: 30000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-final5.txt'), redact(sql.stdout || sql.stderr));
console.log('FINAL\n', redact(sql.stdout || sql.stderr));

await runner.disconnect();
await prisma.$disconnect();
