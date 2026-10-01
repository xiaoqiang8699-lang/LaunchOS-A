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
const {
  createInstallationAccessToken,
  createGitHubAppJwt,
  readGitHubAppCredentials,
} = requireApi('@launchos/github');
const bcrypt = requireApi('bcrypt');

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
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

const connSql = await runner.execute(
  shellCommand(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT c.id, c.status, c.\\"installationId\\", c.\\"workspaceId\\", s.\\"authStatus\\" FROM \\"GitProviderConnection\\" c LEFT JOIN \\"SourceRepository\\" s ON s.\\"connectionId\\"=c.id WHERE s.\\"projectId\\"='cmunhwais0003rl01wqj1qy11' OR c.id='cmump0lbq0018rl01n2beawv6';"`),
  { timeoutMs: 20000 },
);
console.log('CONN', redact(connSql.stdout || connSql.stderr));
const connLine = String(connSql.stdout || '').trim().split(/\n/).filter(Boolean)[0] || '';
const [connectionId, status, installationId] = connLine.split('|');
console.log({ connectionId, status, installationId });

const creds = readGitHubAppCredentials();
if (!creds) throw new Error('local GitHub App credentials missing');
createGitHubAppJwt(creds.appId, creds.privateKey);
try {
  const token = await createInstallationAccessToken(installationId);
  console.log('INSTALL_TOKEN_OK', Boolean(token?.token), token?.expiresAt || null);
} catch (e) {
  console.log('INSTALL_TOKEN_FAIL', redact(e instanceof Error ? e.message : String(e)));
  throw e;
}

// Restore ACTIVE after false NEEDS_REAUTH from earlier worker/App misconfig
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-reactivate.sql',
  `UPDATE "GitProviderConnection" SET status='ACTIVE', "updatedAt"=NOW() WHERE id='${connectionId}';
UPDATE "SourceRepository" SET "authStatus"='OK' WHERE "connectionId"='${connectionId}';
UPDATE "LaunchRun" SET status='WAITING_CONFIRMATION', "failureCode"=NULL, "failureMessage"=NULL, "finishedAt"=NULL, "startedAt"=NULL,
  "confirmationId"=NULL, "confirmedAt"=NULL, "confirmedByUserId"=NULL, "confirmedPlanHash"=NULL, "confirmationSnapshot"=NULL
WHERE id='cmunhwddb0019rl01fzipihgn';
`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-reactivate.sql launchos-alpha-postgres:/tmp/step317-reactivate.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-reactivate.sql',
  ),
  { timeoutMs: 20000 },
);
console.log('REACTIVATED');

const ownerEmail = (
  await runner.execute(
    shellCommand(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='cmunhwais0003rl01wqj1qy11';"`),
    { timeoutMs: 20000 },
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcrypt.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass7.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-pass7.sql launchos-alpha-postgres:/tmp/step317-pass7.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass7.sql',
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
console.log('PLAN', plan.status, redact(plan.text).slice(0, 350));
const planJson = JSON.parse(plan.text || '{}');
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
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth });
  final = JSON.parse(st.text || '{}');
  console.log(`[poll ${i}] status=${final.status} stage=${final.currentStage || ''} step=${final.currentStep || ''} msg=${final.userMessage || ''}`);
  if (final.status === 'SUCCESS' || final.status === 'FAILED' || final.status === 'CANCELLED') break;
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-final2.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("failureMessage",''),300) FROM "LaunchRun" WHERE id='${planJson.launchRunId || 'cmunhwddb0019rl01fzipihgn'}';
SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),300) FROM "Deployment" WHERE "projectId"='cmunhwais0003rl01wqj1qy11' ORDER BY "createdAt" DESC LIMIT 5;
SELECT ds."stepKey", ds.status, left(coalesce(ds."errorMessage",''),200) FROM "DeploymentStep" ds
WHERE ds."deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='cmunhwais0003rl01wqj1qy11' ORDER BY "createdAt" DESC LIMIT 1)
ORDER BY ds."order";
SELECT id, hostname, status FROM "GatewayRoute" WHERE "projectId"='cmunhwais0003rl01wqj1qy11' ORDER BY "updatedAt" DESC LIMIT 5;
SELECT id, status, coalesce("externalPort"::text,''), coalesce("containerId",'') FROM "ServiceInstance" WHERE "projectId"='cmunhwais0003rl01wqj1qy11' ORDER BY "updatedAt" DESC LIMIT 5;
`,
);
const sql = await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-final2.sql launchos-alpha-postgres:/tmp/step317-final2.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step317-final2.sql',
  ),
  { timeoutMs: 30000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-retry2.txt'), redact(sql.stdout || sql.stderr));
console.log('FINAL\n', redact(sql.stdout || sql.stderr));

await runner.disconnect();
await prisma.$disconnect();
