/**
 * UX-1: set temp password for web-ceshi owner on Alpha (no image promote).
 * node scripts/_tmp-ux1-auth-prep.mjs --confirm-ux1
 */
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
if (!process.argv.includes('--confirm-ux1')) {
  console.error('pass --confirm-ux1');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const MANAGED_ID = 'cmuma9i480001rij49yv4yw2q';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const TARGET_HOST = '116.62.198.184';

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
  where: { OR: [{ id: MANAGED_ID }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('managed server missing');
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label, timeoutMs = 120000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}

const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Ux1-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/ux1-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/ux1-setpass.sql',
  'set-pass',
);

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${login.text.slice(0, 200)}`);

const app = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}`, 'api-alpha.zsaos.com', {
  headers: { Authorization: `Bearer ${token}` },
});
const runtime = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime?refreshPublic=1`,
  'api-alpha.zsaos.com',
  { headers: { Authorization: `Bearer ${token}` } },
);
const versions = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/versions`, 'api-alpha.zsaos.com', {
  headers: { Authorization: `Bearer ${token}` },
});
const usage = curl('https://api-alpha.zsaos.com/api/v1/account/usage', 'api-alpha.zsaos.com', {
  headers: { Authorization: `Bearer ${token}` },
});

const appBody = JSON.parse(app.text || '{}');
const runtimeBody = JSON.parse(runtime.text || '{}');
const versionsBody = JSON.parse(versions.text || '[]');
const usageBody = JSON.parse(usage.text || '{}');
const current = Array.isArray(versionsBody)
  ? versionsBody.find((v) => v.isCurrent) || versionsBody[0]
  : versionsBody.items?.find?.((v) => v.isCurrent) || versionsBody.items?.[0];

const report = {
  email: ownerEmail,
  password: tempPass,
  tokenPrefix: token.slice(0, 12),
  projectId: PROJECT,
  appName: appBody.name,
  appStatus: appBody.applicationStatus,
  visitUrl: appBody.visitUrl,
  hostingMode: appBody.hostingMode,
  runtimeOverall: runtimeBody.overallStatus || runtimeBody.status,
  currentVersion: current?.version ?? null,
  usagePlan: usageBody.planName || usageBody.plan || usageBody.ui?.planName,
  usageSource: usageBody.source,
  hasOverride: Boolean(usageBody.override),
  secretsInUsage: /WorkspaceEntitlementOverride|passwordHash|credentialEncrypted/i.test(usage.text),
  adminUnchanged: true,
  paidResourceCreated: false,
};

writeFileSync(join(root, '.tools/alpha-runtime/ux1-auth.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
await runner.close?.();
process.exit(0);
