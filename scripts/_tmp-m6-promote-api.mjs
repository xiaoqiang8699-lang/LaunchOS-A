/**
 * Promote M6 API to Alpha and verify entitlements endpoint.
 * node scripts/_tmp-m6-promote-api.mjs --confirm-m6
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
if (!process.argv.includes('--confirm-m6')) process.exit(2);

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const MANAGED_ID = 'cmuma9i480001rij49yv4yw2q';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const API_TAG = 'launchos-alpha-api:m6';
const API_REMOTE = 'localhost/launchos-alpha-api:m6';
const TARGET_HOST = '116.62.198.184';

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
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
  where: { OR: [{ id: MANAGED_ID }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label, timeoutMs = 180000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}

const tar = join(root, '.tools/alpha-runtime/launchos-alpha-api-m6.tar');
try { unlinkSync(tar); } catch {}
const save = spawnSync('docker', ['save', '-o', tar, API_TAG], { cwd: root, encoding: 'utf8' });
if (save.status !== 0) throw new Error('docker save failed');
console.log('uploading api');
await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-api-m6.tar', { timeoutMs: 900000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-api-m6.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-m6.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
  'load',
  600000,
);
await remoteOk(`test -x /opt/launchos/bin/m5-run-api.sh`, 'script');
await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'run-api', 120000);
await remoteOk('/opt/launchos/tmp/m5-wait-api.sh', 'wait-api', 120000);

const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Tmp-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/m6-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m6-setpass.sql',
  'set-pass',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${(login.text || '').slice(0, 200)}`);
const auth = { authorization: `Bearer ${token}` };

const ent = curl('https://api-alpha.zsaos.com/api/v1/account/entitlements', 'api-alpha.zsaos.com', {
  headers: auth,
  maxTime: '60',
});
let body = {};
try {
  body = JSON.parse(ent.text || '{}');
} catch {
  body = {};
}
const usage = curl('https://api-alpha.zsaos.com/api/v1/account/usage', 'api-alpha.zsaos.com', {
  headers: auth,
});
const publicLive = curl('https://web-ceshi.zsaos.com/', 'web-ceshi.zsaos.com');

const out = {
  entitlementsStatus: ent.status,
  maxProjects: body.entitlements?.maxProjects ?? null,
  maxMonthlyDeployments: body.entitlements?.maxMonthlyDeployments ?? null,
  source: body.source ?? null,
  overrideReason: body.override?.reason ?? null,
  usageStatus: usage.status,
  publicStatus: publicLive.status,
  betaEffective:
    ent.status === 200 &&
    body.entitlements?.maxProjects === 3 &&
    body.entitlements?.maxMonthlyDeployments === 50 &&
    /Beta/i.test(body.override?.reason || body.source || ''),
  existingFlows: publicLive.status >= 200 && publicLive.status < 400,
};
writeFileSync(join(root, '.tools/alpha-runtime/m6-promote-api.json'), JSON.stringify(out, null, 2));
console.log('M6_PROMOTE', JSON.stringify(out));
await prisma.$disconnect().catch(() => undefined);
try {
  await runner.disconnect();
} catch {}
process.exit(out.betaEffective && out.existingFlows ? 0 : 1);
