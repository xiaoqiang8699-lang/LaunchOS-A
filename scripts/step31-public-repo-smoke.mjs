/**
 * One-shot public repo analyze smoke on Alpha (new free user, one project).
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

const TARGET = '116.62.198.184';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = 'https://alpha.zsaos.com';
const API_ORIGIN = `https://${API_HOST}`;

function curl(url, host, { method = 'GET', headers = {}, body = null } = {}) {
  const args = ['-k', '-sS', '-X', method, '--resolve', `${host}:443:${TARGET}`, '-w', '\n__STATUS__:%{http_code}'];
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

const email = `alpha-smoke-${Date.now()}@zsaos.test`;
const password = `Alpha${randomBytes(5).toString('hex')}!aA1`;
curl(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
  method: 'POST',
  headers: { origin: WEB_ORIGIN },
  body: JSON.stringify({ email, password, name: 'Alpha Smoke' }),
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
  body: JSON.stringify({
    cloneUrl: 'https://github.com/octocat/Hello-World.git',
    branch: 'master',
  }),
});
console.log('public', pub.status, pub.text.slice(0, 400));

const analyze = curl(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
  method: 'POST',
  headers: auth,
});
console.log('analyze', analyze.status, analyze.text.slice(0, 600));

const plan = curl(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
  method: 'POST',
  headers: auth,
});
console.log('plan', plan.status, plan.text.slice(0, 600));

// worker heartbeat via SSH
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});
const hb = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id, status, \\"updatedAt\\" FROM \\"WorkerHeartbeat\\" WHERE status='ONLINE' ORDER BY \\"updatedAt\\" DESC LIMIT 3;"`,
  ),
  { timeoutMs: 30000 },
);
console.log('worker', hb.exitCode, String(hb.stdout || hb.stderr || '').slice(0, 500));
await runner.disconnect();
await prisma.$disconnect();
