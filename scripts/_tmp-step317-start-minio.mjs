/**
 * Start colocated MinIO on Alpha host + relaunch Step 31.7.
 * node scripts/_tmp-step317-start-minio.mjs --confirm-minio
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
if (!process.argv.includes('--confirm-minio')) {
  console.error('pass --confirm-minio');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

function redact(t) {
  return String(t || '')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY|MINIO_SECRET|MINIO_ROOT)[=:][^\s"']+/gi, '$1=***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = [
    '-k', '-sS', '-X', method,
    '--resolve', `${host}:443:116.62.198.184`,
    '-w', '\n__STATUS__:%{http_code}',
    '--max-time', String(maxTime),
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
});

async function remoteOk(command, label, opts = {}) {
  const r = await runner.execute(shellCommand(command), { timeoutMs: opts.timeoutMs ?? 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1200)}`);
  return r;
}

await remoteOk('mkdir -p /opt/launchos/data/minio /opt/launchos/bin /opt/launchos/tmp', 'mkdir');

await runner.writeTextFile(
  '/opt/launchos/bin/step317-prep-minio-env.py',
  `from pathlib import Path
env = {}
for line in Path('/opt/launchos/config/alpha-api.env').read_text().splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    env[k.strip()] = v.strip().strip('"').strip("'")
need = ['MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_BUCKET']
missing = [k for k in need if not env.get(k)]
if missing:
    raise SystemExit('missing ' + ','.join(missing))
Path('/opt/launchos/tmp/step317-minio.env').write_text(
    'MINIO_ROOT_USER=' + env['MINIO_ACCESS_KEY'] + '\\n'
    + 'MINIO_ROOT_PASSWORD=' + env['MINIO_SECRET_KEY'] + '\\n'
)
print('ENDPOINT=' + env['MINIO_ENDPOINT'])
print('BUCKET=' + env['MINIO_BUCKET'])
print('KEYS_OK')
`,
);

const keysOut = await remoteOk('python3 /opt/launchos/bin/step317-prep-minio-env.py', 'read-minio-env');
console.log(redact(keysOut.stdout || ''));

await runner.writeTextFile(
  '/opt/launchos/bin/step317-run-minio.sh',
  `#!/bin/bash
set -euo pipefail
set -a
# shellcheck disable=SC1091
source /opt/launchos/tmp/step317-minio.env
set +a
podman rm -f launchos-alpha-minio 2>/dev/null || true
IMG=""
for candidate in quay.io/minio/minio:RELEASE.2024-12-18T13-15-44Z minio/minio:latest docker.io/minio/minio:latest; do
  if podman image exists "$candidate" 2>/dev/null; then IMG="$candidate"; break; fi
done
if [ -z "$IMG" ]; then
  podman pull quay.io/minio/minio:RELEASE.2024-12-18T13-15-44Z || podman pull docker.io/minio/minio:latest
  if podman image exists quay.io/minio/minio:RELEASE.2024-12-18T13-15-44Z 2>/dev/null; then
    IMG=quay.io/minio/minio:RELEASE.2024-12-18T13-15-44Z
  else
    IMG=docker.io/minio/minio:latest
  fi
fi
podman run -d --name launchos-alpha-minio \\
  --restart unless-stopped \\
  --network host \\
  -e MINIO_ROOT_USER \\
  -e MINIO_ROOT_PASSWORD \\
  -v /opt/launchos/data/minio:/data \\
  "$IMG" server /data --address 127.0.0.1:9000 --console-address 127.0.0.1:9001
echo STARTED img=$IMG
`,
);

console.log('[1] start minio');
await remoteOk('chmod 700 /opt/launchos/bin/step317-run-minio.sh && /opt/launchos/bin/step317-run-minio.sh', 'start-minio', {
  timeoutMs: 600000,
});
await remoteOk(
  `i=0; while [ $i -lt 40 ]; do i=$((i+1)); code=$(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:9000/minio/health/live || true); if [ "$code" = "200" ]; then echo MINIO_HEALTH_OK; exit 0; fi; sleep 2; done; podman logs --tail 50 launchos-alpha-minio; exit 1`,
  'minio-health',
  { timeoutMs: 180000 },
);

await runner.writeTextFile(
  '/opt/launchos/bin/step317-ensure-bucket.sh',
  `#!/bin/bash
set -euo pipefail
set -a
source /opt/launchos/tmp/step317-minio.env
set +a
BUCKET=$(sed -n 's/^MINIO_BUCKET=//p' /opt/launchos/config/alpha-api.env | head -1 | tr -d '"' | tr -d "'")
BUCKET=\${BUCKET:-launchos-artifacts}
podman pull docker.io/minio/mc:latest >/tmp/mc-pull.log 2>&1 || true
podman run --rm --network host --env-file /opt/launchos/tmp/step317-minio.env \\
  docker.io/minio/mc:latest \\
  /bin/sh -c "mc alias set local http://127.0.0.1:9000 \\"\$MINIO_ROOT_USER\\" \\"\$MINIO_ROOT_PASSWORD\\" && mc mb -p local/\$BUCKET || true && mc ls local" \\
  || echo 'mc ensure soft-fail'
echo BUCKET_ENSURE_DONE bucket=\$BUCKET
`,
);
const bucket = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-ensure-bucket.sh && /opt/launchos/bin/step317-ensure-bucket.sh'),
  { timeoutMs: 600000 },
);
console.log(redact(bucket.stdout || bucket.stderr || '').slice(0, 1500));

console.log('[2] reset + relaunch');
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6'; UPDATE \\"LaunchRun\\" SET status='WAITING_CONFIRMATION', \\"failureCode\\"=NULL, \\"failureMessage\\"=NULL, \\"finishedAt\\"=NULL, \\"startedAt\\"=NULL, \\"confirmationId\\"=NULL, \\"confirmedAt\\"=NULL, \\"confirmedByUserId\\"=NULL, \\"confirmedPlanHash\\"=NULL, \\"confirmationSnapshot\\"=NULL WHERE id='cmunhwddb0019rl01fzipihgn';"`,
  'reset',
);

const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='cmunhwais0003rl01wqj1qy11';"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass15.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step317-pass15.sql launchos-alpha-postgres:/tmp/step317-pass15.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass15.sql',
  'pass',
);

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed ${login.status} ${redact(login.text).slice(0, 200)}`);
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

const plan = curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  maxTime: '180',
});
console.log('PLAN', plan.status, redact(plan.text).slice(0, 400));
const confirm = curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
});
console.log('CONFIRM', confirm.status, redact(confirm.text).slice(0, 300));
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
});
console.log('START', start.status, redact(start.text).slice(0, 400));

let final = null;
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', {
    headers: auth,
    maxTime: '30',
  });
  try {
    final = JSON.parse(st.text || '{}');
  } catch {
    final = { status: 'PARSE_ERROR', raw: st.text };
  }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) break;
}

const result = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),200) FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn'; SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),200), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"createdAt\\" DESC LIMIT 4; SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"containerName\\",''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"updatedAt\\" DESC LIMIT 6; SELECT id, hostname, status FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"updatedAt\\" DESC LIMIT 6;"`,
  'result',
);
console.log('RESULT\n' + redact(result.stdout || ''));
writeFileSync(
  join(root, '.tools/alpha-runtime/step317-minio-relaunch.txt'),
  redact(JSON.stringify({ final, result: result.stdout }, null, 2)),
);

await runner.disconnect();
await prisma.$disconnect();
process.exit(final?.status === 'SUCCESS' ? 0 : 1);
