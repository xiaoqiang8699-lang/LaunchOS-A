/**
 * Reset Alpha user password for 1002@qq.com to a known value.
 * node scripts/_tmp-reset-1002-password.mjs --confirm
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
if (!process.argv.includes('--confirm')) {
  console.error('pass --confirm');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');
const { spawnSync } = await import('node:child_process');

const TARGET_HOST = '116.62.198.184';
const EMAIL = '1002@qq.com';
const NEW_PASSWORD = '12345678';

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('platform server missing');
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, timeoutMs = 120000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

const hash = await bcryptLib.hash(NEW_PASSWORD, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/reset-1002-pass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${EMAIL.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/reset-1002-pass.sql',
  'set-pass',
);
await remoteOk('rm -f /opt/launchos/tmp/reset-1002-pass.sql', 'cleanup');

function curl(url, host, opts = {}) {
  const args = ['-sS', '-L', '-X', opts.method || 'GET', '-w', '\n__STATUS__:%{http_code}', '--max-time', '30', '--resolve', `${host}:443:${TARGET_HOST}`];
  for (const [k, v] of Object.entries(opts.headers || {})) args.push('-H', `${k}: ${v}`);
  if (opts.body != null) args.push('-H', 'content-type: application/json', '--data-binary', opts.body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: EMAIL, password: NEW_PASSWORD }),
});
let ok = false;
try {
  ok = Boolean(JSON.parse(login.text || '{}').accessToken);
} catch {}

const outDir = resolve(root, '.tools/alpha-runtime');
mkdirSync(outDir, { recursive: true });
const auth = { email: EMAIL, password: NEW_PASSWORD, loginStatus: login.status, loginOk: ok };
writeFileSync(join(outDir, '1002-auth.json'), JSON.stringify(auth, null, 2));
console.log(JSON.stringify(auth, null, 2));

await prisma.$disconnect();
try {
  await runner.disconnect();
} catch {}
if (!ok) process.exit(1);
