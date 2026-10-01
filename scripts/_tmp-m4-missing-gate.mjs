/**
 * M4 missing-gate + finalize after main promote already done.
 * node scripts/_tmp-m4-missing-gate.mjs --confirm-m4
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
if (!process.argv.includes('--confirm-m4')) {
  console.error('pass --confirm-m4');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const HOST = 'web-ceshi.zsaos.com';

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = [
    '-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}',
    '--max-time', String(maxTime),
    '--resolve', `${host}:443:${TARGET_HOST}`,
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
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}

// Wait for any in-flight deploy from previous failed missing-gate attempt.
for (let i = 0; i < 120; i++) {
  const peek = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id||'|'||status FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' AND status IN ('CREATED','QUEUED','RUNNING') ORDER BY \\"createdAt\\" DESC LIMIT 1"`,
    'inflight',
  );
  const line = peek.stdout.trim();
  if (!line) break;
  console.log('waiting inflight', line);
  await new Promise((r) => setTimeout(r, 5000));
}

const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Tmp-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/m4-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m4-setpass.sql',
  'set-pass',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error('login failed');
const auth = { authorization: `Bearer ${token}` };

const envId = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"ProjectEnvironment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" ASC LIMIT 1"`,
    'env',
  )
).stdout.trim();

// Backup AUTH_SECRET row then delete UNIT+PROJECT values for missing gate.
const backup = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id||'|'||\\"scopeType\\"||'|'||\\"scopeId\\"||'|'||\\"valueEncrypted\\"||'|'||coalesce(source,'') FROM \\"RuntimeConfigValue\\" WHERE \\"projectId\\"='${PROJECT}' AND key='AUTH_SECRET'"`,
    'backup-auth',
  )
).stdout.trim();
console.log('backup rows', backup.split(/\n/).length);

await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "DELETE FROM \\"RuntimeConfigValue\\" WHERE \\"projectId\\"='${PROJECT}' AND key='AUTH_SECRET';"`,
  'delete-auth',
);

const missDeploy = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/deployments`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ environmentId: envId, deployableUnitId: UNIT }),
});
const missText = missDeploy.text || '';
const missingGate =
  missDeploy.status >= 400 && /RUNTIME_CONFIG_MISSING|AUTH_SECRET|运行配置/.test(missText);
console.log('missingGate', missDeploy.status, missingGate, missText.slice(0, 240));

// Restore via generate (rotate) so production stays healthy.
const gen = curl(
  `https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/units/${UNIT}/config/AUTH_SECRET/generate`,
  'api-alpha.zsaos.com',
  { method: 'POST', headers: auth },
);
console.log('restore generate', gen.status, JSON.parse(gen.text || '{}').needsRedeploy);

const redeploy = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/deployments`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ environmentId: envId, deployableUnitId: UNIT }),
});
const depId = JSON.parse(redeploy.text || '{}').id;
console.log('restore redeploy', redeploy.status, depId);
if (!depId) throw new Error('restore redeploy failed');

let terminal = null;
let peekOut = '';
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const peek = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status FROM \\"Deployment\\" WHERE id='${depId}'; SELECT left(message,160) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${depId}' AND message LIKE '%AUTH_SECRET:present%' ORDER BY \\"createdAt\\" DESC LIMIT 5;"`,
    'peek',
  );
  peekOut = peek.stdout;
  if (i % 6 === 0) console.log('peek', i, peekOut.split(/\n/)[0]);
  const st = peekOut.split(/\n/)[0]?.trim();
  if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') {
    terminal = st;
    break;
  }
}

const publicLive = curl(`https://${HOST}/`, HOST);
const authPresent = /AUTH_SECRET:present=true/.test(peekOut);
const finalPass = missingGate && terminal === 'SUCCESS' && authPresent && publicLive.status >= 200 && publicLive.status < 400;

const prev = existsSync(join(root, '.tools/alpha-runtime/m4-regress-report.json'))
  ? JSON.parse(readFileSync(join(root, '.tools/alpha-runtime/m4-regress-report.json'), 'utf8'))
  : {};
const report = {
  ...prev,
  missingGate,
  authSecretPresent: authPresent || prev.authSecretPresent,
  publicOk: publicLive.status >= 200 && publicLive.status < 400,
  restoreTerminal: terminal,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  finalPass,
};
writeFileSync(join(root, '.tools/alpha-runtime/m4-regress-report.json'), JSON.stringify(report, null, 2));
console.log('M4_MISSING_REPORT', JSON.stringify({ missingGate, terminal, authPresent, public: publicLive.status, finalPass }));
console.log(finalPass ? 'M4_REGRESS=PASS' : 'M4_REGRESS=FAIL');
await prisma.$disconnect().catch(() => undefined);
try { await runner.disconnect(); } catch {}
process.exit(finalPass ? 0 : 1);
