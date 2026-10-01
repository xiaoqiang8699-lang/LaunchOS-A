import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env')]) {
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

const TARGET = '116.62.198.184';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = 'https://alpha.zsaos.com';
const API_ORIGIN = `https://${API_HOST}`;

function curl(url, host, { method = 'GET', headers = {}, body = null } = {}) {
  const args = [
    '-k', '-sS', '-X', method,
    '--resolve', `${host}:443:${TARGET}`,
    '-w', '\n__STATUS__:%{http_code}',
    '--max-time', '180',
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) {
    args.push('-H', 'content-type: application/json');
    args.push('--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const email = `alpha-git311b-${Date.now()}@zsaos.test`;
const password = `Alpha${randomBytes(5).toString('hex')}!aA1`;
curl(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
  method: 'POST',
  headers: { origin: WEB_ORIGIN },
  body: JSON.stringify({ email, password, name: 'Git311b' }),
});
const login = curl(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
  method: 'POST',
  headers: { origin: WEB_ORIGIN },
  body: JSON.stringify({ email, password }),
});
const token = JSON.parse(login.text).accessToken;
const auth = { authorization: `Bearer ${token}`, origin: WEB_ORIGIN };
const pub = curl(`${API_ORIGIN}/api/v1/onboarding/source/public`, API_HOST, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ cloneUrl: 'https://github.com/octocat/Hello-World.git', branch: 'master' }),
});
console.log('public', pub.status, pub.text.slice(0, 400));
const analyze = curl(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
  method: 'POST',
  headers: auth,
});
console.log('analyze', analyze.status, analyze.text.slice(0, 800));

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});
const logs = await runner.execute(
  shellCommand(
    "podman logs --tail 250 launchos-alpha-api 2>&1 | grep -E 'Error|ERROR|Git|git|clone|Hello|analyze|ENOENT|Exception|无法' | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^ ]+/\\1=***/gi' | tail -80",
  ),
  { timeoutMs: 60000 },
);
console.log('===FILTERED LOGS===');
console.log(String(logs.stdout || '').slice(0, 5000));
console.log(String(logs.stderr || '').slice(0, 1000));
await runner.disconnect();
await prisma.$disconnect();
