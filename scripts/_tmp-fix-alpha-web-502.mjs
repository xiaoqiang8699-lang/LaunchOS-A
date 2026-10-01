/**
 * Fix alpha.zsaos.com 502: restart web with PORT=3000 HOSTNAME=0.0.0.0.
 * Optionally rebuild image from fixed Dockerfile (--rebuild).
 * node scripts/_tmp-fix-alpha-web-502.mjs --confirm
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
if (!process.argv.includes('--confirm')) {
  console.error('pass --confirm');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const WEB_TAG = 'launchos-alpha-web:step35';
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_WEB = 'launchos-alpha-web';
const HOST_PORT = 39082;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const rebuild = process.argv.includes('--rebuild');

function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

console.log('[1] logs before');
const before = await remoteOk(
  `podman ps -a --filter name=${LIVE_WEB} --format '{{.Names}} {{.Status}} {{.Ports}}'; echo ---; podman logs --tail 50 ${LIVE_WEB} 2>&1`,
  'before',
);
console.log(before.stdout);

if (rebuild) {
  console.log('[2] rebuild web image with PORT=3000 contract');
  const b = local('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    'deploy/alpha/Dockerfile.web',
    '-t',
    WEB_TAG,
    '--build-arg',
    'NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com',
    '.',
  ]);
  writeFileSync(join(ARTIFACT_DIR, 'step35-web-rebuild.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-200000));
  if (b.status !== 0) throw new Error('web rebuild failed');
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-web-step35-portfix.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, WEB_TAG]).status !== 0) throw new Error('save failed');
  await remoteOk('mkdir -p /opt/launchos/tmp', 'mkdir');
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-web-step35-portfix.tar', { timeoutMs: 600000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-web-step35-portfix.tar && rm -f /opt/launchos/tmp/launchos-alpha-web-step35-portfix.tar && (podman tag docker.io/library/${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || podman tag ${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || true)`,
    'load',
    { timeoutMs: 300000 },
  );
}

console.log('[3] recreate web with explicit listen contract');
await runner.writeTextFile(
  '/opt/launchos/bin/step35-run-web-fixed.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"; HOSTPORT="$3"
podman rm -f "$NAME" 2>/dev/null || true
sleep 1
podman run -d --name "$NAME" --restart unless-stopped \\
  -p 127.0.0.1:\${HOSTPORT}:3000 \\
  -e PORT=3000 \\
  -e HOSTNAME=0.0.0.0 \\
  -e NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com \\
  "$IMAGE"
echo STARTED
sleep 2
podman logs --tail 20 "$NAME" 2>&1 || true
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step35-run-web-fixed.sh', 'chmod');
await remoteOk(`/opt/launchos/bin/step35-run-web-fixed.sh ${LIVE_WEB} ${WEB_REMOTE} ${HOST_PORT}`, 'run-web', {
  timeoutMs: 120000,
});

console.log('[4] ensure nginx -> 39082');
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'alpha.zsaos.com',
  healthPath: '/',
  targetPort: HOST_PORT,
});

console.log('[5] verify');
await runner.writeTextFile(
  '/opt/launchos/tmp/step35-web-verify.sh',
  `#!/bin/bash
set +e
echo LOCAL=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:${HOST_PORT}/)
echo PUBLIC=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://alpha.zsaos.com/)
echo DASH=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://alpha.zsaos.com/dashboard)
echo LOGS:
podman logs --tail 15 ${LIVE_WEB} 2>&1
echo NGINX:
grep -n 'alpha.zsaos.com\\|proxy_pass' /opt/launchos/gateway/active/launchos-routes.conf | head -30
`,
);
const verify = await remoteOk('chmod 700 /opt/launchos/tmp/step35-web-verify.sh && /opt/launchos/tmp/step35-web-verify.sh', 'verify', {
  timeoutMs: 90000,
});
console.log(verify.stdout);

const fromPc = spawnSync(
  'curl.exe',
  ['-sS', '--max-time', '25', '-w', '\nHTTP:%{http_code}\n', 'https://alpha.zsaos.com/dashboard'],
  { encoding: 'utf8', maxBuffer: 2_000_000 },
);
console.log('FROM_PC_NO_K', String(fromPc.stdout || '').slice(0, 250), fromPc.stderr?.slice(0, 200));

await runner.disconnect();
await prisma.$disconnect();

const localCode = Number((String(verify.stdout || '').match(/LOCAL=(\d+)/) || [])[1] || 0);
const publicCode = Number((String(verify.stdout || '').match(/PUBLIC=(\d+)/) || [])[1] || 0);
const pcCode = Number((String(fromPc.stdout || '').match(/HTTP:(\d+)/) || [])[1] || 0);
const pass = localCode === 200 && publicCode === 200 && pcCode === 200;
console.log(pass ? 'ALPHA_WEB_FIX=PASS' : `ALPHA_WEB_FIX=FAIL local=${localCode} public=${publicCode} pc=${pcCode}`);
process.exit(pass ? 0 : 1);
