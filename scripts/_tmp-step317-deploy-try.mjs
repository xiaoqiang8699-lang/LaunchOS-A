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
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
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
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^\s]+/gi, '$1=***');
}
function curl(url, host, { method = 'GET', headers = {}, body = null, maxTime = '180' } = {}) {
  const args = [
    '-k', '-sS', '-X', method, '--resolve', `${host}:443:116.62.198.184`,
    '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime),
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
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 20000,
});

const ownerEmail = (
  await runner.execute(
    shellCommand(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='cmunhwais0003rl01wqj1qy11';"`),
    { timeoutMs: 20000 },
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcrypt.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass3.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-pass3.sql launchos-alpha-postgres:/tmp/step317-pass3.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass3.sql',
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

const code = curl(
  'https://api-alpha.zsaos.com/api/v1/projects/cmunhwais0003rl01wqj1qy11/code-analysis',
  'api-alpha.zsaos.com',
  { method: 'POST', headers: auth, maxTime: '300' },
);
console.log('CODE_ANALYSIS', code.status, redact(code.text).slice(0, 800));

const dep = curl(
  'https://api-alpha.zsaos.com/api/v1/projects/cmunhwais0003rl01wqj1qy11/deployments',
  'api-alpha.zsaos.com',
  {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      environmentId: 'cmunhwaiw0007rl01frx7co7o',
      hostingMode: 'launchos',
      targetType: 'MANAGED_SERVER',
    }),
    maxTime: '180',
  },
);
console.log('DEPLOY_CREATE', dep.status, redact(dep.text).slice(0, 1000));

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-dep.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),500) FROM "Deployment" WHERE "projectId"='cmunhwais0003rl01wqj1qy11' ORDER BY "createdAt" DESC LIMIT 5;`,
);
const sql = await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-dep.sql launchos-alpha-postgres:/tmp/step317-dep.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step317-dep.sql',
  ),
  { timeoutMs: 30000 },
);
console.log('DEP_SQL', redact(sql.stdout || sql.stderr));

const apiLogs = await runner.execute(shellCommand('podman logs --tail 60 launchos-alpha-api'), {
  timeoutMs: 30000,
});
writeFileSync(join(root, '.tools/alpha-runtime/step317-api-logs2.txt'), redact(apiLogs.stdout || apiLogs.stderr));
console.log('API_LOG\n', redact(apiLogs.stdout || '').slice(-2500));

await runner.disconnect();
await prisma.$disconnect();
