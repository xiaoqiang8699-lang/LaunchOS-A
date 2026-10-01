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
const TARGET_HOST = '116.62.198.184';
const EMAIL = 'xiaoqiang8699@gmail.com';

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '60' } = opts;
  const args = [
    '-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}',
    '--max-time', String(maxTime), '--resolve', `${host}:443:${TARGET_HOST}`,
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  return r;
}

const legacy = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: EMAIL, password: 'Launchos123!' }),
});
let pass = 'Launchos123!';
if (!JSON.parse(legacy.text || '{}').accessToken) {
  pass = `Admin-${randomBytes(4).toString('hex')}!`;
  const hash = await bcryptLib.hash(pass, 10);
  await runner.writeTextFile(
    '/opt/launchos/tmp/admin-setpass.sql',
    `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}', "platformRole"='PLATFORM_ADMIN' WHERE email='${EMAIL.replace(/'/g, "''")}';\n`,
  );
  await remoteOk(
    'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/admin-setpass.sql',
    'set-pass',
  );
}

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: EMAIL, password: pass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`admin login failed: ${(login.text || '').slice(0, 200)}`);
const overview = curl('https://api-alpha.zsaos.com/api/v1/admin/overview', 'api-alpha.zsaos.com', {
  headers: { authorization: `Bearer ${token}` },
});
const out = {
  url: 'https://alpha.zsaos.com/admin',
  loginUrl: 'https://alpha.zsaos.com/login',
  email: EMAIL,
  password: pass,
  passwordWasReset: pass !== 'Launchos123!',
  loginStatus: login.status,
  adminOverviewStatus: overview.status,
};
writeFileSync(join(root, '.tools/alpha-runtime/admin-auth.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
