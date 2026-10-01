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
const { decryptCredential, resolveServerSshUsername, shellCommand, encryptCredential } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcrypt = requireApi('bcrypt');

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|JWT_)[=:][^\s]+/gi, '$1=***');
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
const UNITS = ['cmunhwc9g000brl01bgid72o7', 'cmunhwc9k000drl01gxu1qwq2'];

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

// Generate encrypted values locally (same encryptCredential as platform) and upsert via SQL is hard;
// instead run a small node script inside API container that uses @launchos/shared encryptCredential.
const jwt = `alpha_${randomBytes(24).toString('hex')}`;
const sentry = 'https://public@sentry.invalid/0';
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-seed-config.mjs',
  `import { createRequire } from 'node:module';
const require = createRequire('/app/apps/api/package.json');
const { PrismaClient } = require('@launchos/database');
const { encryptCredential } = require('@launchos/shared');
const prisma = new PrismaClient();
const projectId = '${PROJECT}';
const unitIds = ${JSON.stringify(UNITS)};
const defaults = {
  JWT_SECRET: ${JSON.stringify(jwt)},
  SENTRY_DSN: ${JSON.stringify(sentry)},
};
for (const unitId of unitIds) {
  const reqs = await prisma.runtimeConfigRequirement.findMany({ where: { deployableUnitId: unitId } });
  for (const req of reqs) {
    const value = defaults[req.key];
    if (!value) continue;
    await prisma.runtimeConfigValue.upsert({
      where: {
        scopeType_scopeId_key: { scopeType: 'UNIT', scopeId: unitId, key: req.key },
      },
      create: {
        projectId,
        scopeType: 'UNIT',
        scopeId: unitId,
        deployableUnitId: unitId,
        requirementId: req.id,
        key: req.key,
        valueEncrypted: encryptCredential(value),
        isSensitive: Boolean(req.sensitive),
        source: 'MANUAL',
      },
      update: {
        valueEncrypted: encryptCredential(value),
        requirementId: req.id,
        isSensitive: Boolean(req.sensitive),
      },
    });
    console.log('SEEDED', unitId, req.key);
  }
}
await prisma.$disconnect();
`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-seed-config.mjs launchos-alpha-api:/tmp/step317-seed-config.mjs && podman exec -w /app launchos-alpha-api node /tmp/step317-seed-config.mjs',
  ),
  { timeoutMs: 60000 },
);
console.log('CONFIG_SEEDED');

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-reset3.sql',
  `UPDATE "GitProviderConnection" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6';
UPDATE "SourceRepository" SET "authStatus"='OK' WHERE "connectionId"='cmump0lbq0018rl01n2beawv6';
UPDATE "LaunchRun" SET status='WAITING_CONFIRMATION', "failureCode"=NULL, "failureMessage"=NULL, "finishedAt"=NULL, "startedAt"=NULL,
  "confirmationId"=NULL, "confirmedAt"=NULL, "confirmedByUserId"=NULL, "confirmedPlanHash"=NULL, "confirmationSnapshot"=NULL
WHERE id='cmunhwddb0019rl01fzipihgn';
`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-reset3.sql launchos-alpha-postgres:/tmp/step317-reset3.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-reset3.sql',
  ),
  { timeoutMs: 20000 },
);

const ownerEmail = (
  await runner.execute(
    shellCommand(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`),
    { timeoutMs: 20000 },
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcrypt.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass9.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-pass9.sql launchos-alpha-postgres:/tmp/step317-pass9.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass9.sql',
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
console.log('PLAN', plan.status, redact(plan.text).slice(0, 300));
curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
});
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
});
console.log('START', start.status, redact(start.text).slice(0, 350));

let final = null;
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth });
  final = JSON.parse(st.text || '{}');
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''}`);
  if (final.status === 'SUCCESS' || final.status === 'FAILED' || final.status === 'CANCELLED') break;
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-final3.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("failureMessage",''),300) FROM "LaunchRun" WHERE id='cmunhwddb0019rl01fzipihgn';
SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),300), coalesce("deployableUnitId",'') FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 6;
SELECT ds."stepKey", ds.status, left(coalesce(ds."errorMessage",''),200)
FROM "DeploymentStep" ds WHERE ds."deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1) ORDER BY ds."order";
SELECT id, hostname, status FROM "GatewayRoute" WHERE "projectId"='${PROJECT}' ORDER BY "updatedAt" DESC LIMIT 6;
SELECT id, status, coalesce("externalPort"::text,''), coalesce("containerId",'') FROM "ServiceInstance" WHERE "projectId"='${PROJECT}' ORDER BY "updatedAt" DESC LIMIT 6;
`,
);
const sql = await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-final3.sql launchos-alpha-postgres:/tmp/step317-final3.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step317-final3.sql',
  ),
  { timeoutMs: 30000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-final3.txt'), redact(sql.stdout || sql.stderr));
console.log('FINAL\n', redact(sql.stdout || sql.stderr));

await runner.disconnect();
await prisma.$disconnect();
