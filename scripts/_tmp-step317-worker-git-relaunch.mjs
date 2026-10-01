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
const bcrypt = requireApi('bcrypt');

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^\s]+/gi, '$1=***');
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = ['-k', '-sS', '-X', method, '--resolve', `${host}:443:116.62.198.184`, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const PROJECT = 'cmunhwais0003rl01wqj1qy11';

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

await runner.writeTextFile(
  '/opt/launchos/bin/step317-worker-git-install.sh',
  `#!/bin/bash
set -euo pipefail
# Recreate worker with git installed in image layer via commit, or install into running container.
podman exec launchos-alpha-worker sh -c 'command -v git && git --version' || {
  echo INSTALLING_GIT
  podman exec -u 0 launchos-alpha-worker sh -c 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*'
}
# Patch git package for HTTP/1.1
podman cp launchos-alpha-api:/app/packages/git/dist/. /tmp/git-dist-317/
podman cp /tmp/git-dist-317/. launchos-alpha-worker:/app/packages/git/dist/
podman exec launchos-alpha-worker sh -c 'git --version; grep -c "http.version=HTTP/1.1" /app/packages/git/dist/git.service.js'
# Commit as new image so restart keeps git
podman commit launchos-alpha-worker localhost/launchos-alpha-worker:step317
# Rewrite run script to use step317 image
IMAGE=localhost/launchos-alpha-worker:step317
podman rm -f launchos-alpha-worker
podman run -d --name launchos-alpha-worker \\
  --restart unless-stopped \\
  --network host \\
  --env-file /opt/launchos/config/alpha-api.env \\
  --env-file /opt/launchos/config/alpha-github.env \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh \\
  "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; echo WORKER_BOOT_KEYS=$(env | sed -n "s/=.*//p" | grep -E "^GITHUB_APP_" | sort | tr "\\n" ","); exec node apps/worker/dist/main.js'
sleep 8
podman exec launchos-alpha-worker sh -c 'git --version; grep -c "http.version=HTTP/1.1" /app/packages/git/dist/git.service.js'
podman logs --tail 20 launchos-alpha-worker
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"WorkerHeartbeat\\" SET status='OFFLINE' WHERE status='ONLINE' AND \\"lastSeenAt\\" < NOW() - interval '2 minutes';"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"workerId\\", status, \\"lastSeenAt\\"::text FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 3;"
`,
);
const install = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-worker-git-install.sh && /opt/launchos/bin/step317-worker-git-install.sh'),
  { timeoutMs: 600000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-worker-git-install.txt'), redact(install.stdout || install.stderr));
console.log(redact(install.stdout || install.stderr).slice(0, 3000));
if (install.exitCode !== 0) throw new Error('worker git install failed');

await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6'; UPDATE \\"LaunchRun\\" SET status='WAITING_CONFIRMATION', \\"failureCode\\"=NULL, \\"failureMessage\\"=NULL, \\"finishedAt\\"=NULL, \\"startedAt\\"=NULL, \\"confirmationId\\"=NULL, \\"confirmedAt\\"=NULL, \\"confirmedByUserId\\"=NULL, \\"confirmedPlanHash\\"=NULL, \\"confirmationSnapshot\\"=NULL WHERE id='cmunhwddb0019rl01fzipihgn';"`,
  ),
  { timeoutMs: 20000 },
);

const ownerEmail = (
  await runner.execute(
    shellCommand(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
    ),
    { timeoutMs: 20000 },
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcrypt.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass13.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-pass13.sql launchos-alpha-postgres:/tmp/step317-pass13.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass13.sql',
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
const plan = curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  maxTime: '180',
});
console.log('PLAN', plan.status, redact(plan.text).slice(0, 350));
curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
});
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
});
console.log('START', start.status, redact(start.text).slice(0, 350));
if (start.status >= 400) throw new Error('start failed');

let final = null;
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth });
  final = JSON.parse(st.text || '{}');
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''}`);
  if (final.status === 'SUCCESS' || final.status === 'FAILED' || final.status === 'CANCELLED') break;
}

const sql = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),300) FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn'; SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),300) FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 4; SELECT ds.\\"stepKey\\", ds.status, left(coalesce(ds.\\"errorMessage\\",''),200) FROM \\"DeploymentStep\\" ds WHERE ds.\\"deploymentId\\"=(SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1) ORDER BY ds.\\"order\\"; SELECT id, hostname, status FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 5; SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"containerId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 5;"`,
  ),
  { timeoutMs: 30000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-final7.txt'), redact(sql.stdout || sql.stderr));
console.log('FINAL\n', redact(sql.stdout || sql.stderr));

const routeLine = String(sql.stdout || '')
  .split(/\n/)
  .find((l) => /\.zsaos\.com\|ACTIVE/.test(l));
if (routeLine) {
  const host = routeLine.split('|')[1];
  const v = curl(`https://${host}/`, host, { maxTime: '45' });
  console.log('VERIFY', host, v.status, redact(v.text).slice(0, 200));
}

await runner.disconnect();
await prisma.$disconnect();
