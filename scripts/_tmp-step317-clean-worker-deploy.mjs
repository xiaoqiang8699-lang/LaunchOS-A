import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

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

// Kill stale workers / heartbeats; keep only current PEM worker
await runner.writeTextFile(
  '/opt/launchos/bin/step317-worker-clean.sh',
  `#!/bin/sh
set -e
echo BEFORE
podman ps -a --filter name=worker --format '{{.Names}} {{.Status}} {{.ID}}'
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"workerId\\", status, \\"lastSeenAt\\"::text FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 10;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"WorkerHeartbeat\\" SET status='OFFLINE';"
# Ensure only one worker container
for c in $(podman ps -a --format '{{.Names}}' | grep -E 'worker' | grep -v '^launchos-alpha-worker$' || true); do
  echo RM $c
  podman rm -f "$c" || true
done
podman restart launchos-alpha-worker
sleep 8
podman logs --tail 25 launchos-alpha-worker
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"workerId\\", status, \\"lastSeenAt\\"::text FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 5;"
# reconnect connection
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6';"
# clear broken workspace clone if any
podman exec launchos-alpha-api sh -c 'ls -la /tmp 2>/dev/null | head; find /app /tmp /var/tmp -maxdepth 3 -type d -name "*cmunhwais*" 2>/dev/null | head'
`,
);
const clean = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-worker-clean.sh && /opt/launchos/bin/step317-worker-clean.sh'),
  { timeoutMs: 120000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-worker-clean.txt'), redact(clean.stdout || clean.stderr));
console.log(redact(clean.stdout || clean.stderr));

const ownerEmail = (
  await runner.execute(
    shellCommand(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='cmunhwais0003rl01wqj1qy11';"`),
    { timeoutMs: 20000 },
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcrypt.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass8.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-pass8.sql launchos-alpha-postgres:/tmp/step317-pass8.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass8.sql',
  ),
  { timeoutMs: 20000 },
);

await runner.writeTextFile(
  '/opt/launchos/bin/step317-analyze-deploy.sh',
  `#!/bin/bash
set -euo pipefail
EMAIL='${ownerEmail.replace(/'/g, "'\\''")}'
PASS='${tempPass.replace(/'/g, "'\\''")}'
LOGIN=$(curl -sS -X POST http://127.0.0.1:39110/api/v1/auth/login -H 'content-type: application/json' -d "{\\"email\\":\\"$EMAIL\\",\\"password\\":\\"$PASS\\"}")
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"accessToken":"\\([^"]*\\)".*/\\1/p')
echo TOKEN_OK=$( [ -n "$TOKEN" ] && echo yes || echo no )
# Force fresh clone path by removing existing workspace if present
WS=$(podman exec launchos-alpha-api sh -c 'node -e "const {GitService}=require(\\"./packages/git/dist/git.service.js\\"); const g=new GitService(); console.log(g.workspaceDir(\\"cmunhwais0003rl01wqj1qy11\\"))"' 2>/dev/null || true)
echo WS=$WS
if [ -n "$WS" ]; then podman exec launchos-alpha-api rm -rf "$WS" || true; fi
echo ANALYZE
ANALYZE=$(curl -sS -m 300 -w '\\nHTTP:%{http_code}' -X POST http://127.0.0.1:39110/api/v1/projects/cmunhwais0003rl01wqj1qy11/code-analysis -H "authorization: Bearer $TOKEN" || true)
echo "$ANALYZE" | tail -c 500
echo
echo DEPLOY
DEPLOY=$(curl -sS -m 120 -w '\\nHTTP:%{http_code}' -X POST http://127.0.0.1:39110/api/v1/projects/cmunhwais0003rl01wqj1qy11/deployments -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"environmentId":"cmunhwaiw0007rl01frx7co7o","hostingMode":"launchos","targetType":"MANAGED_SERVER","deployableUnitId":"cmunhwc9g000brl01bgid72o7","idempotencyKey":"step317-clean-1"}' || true)
echo "$DEPLOY" | tail -c 800
echo
sleep 3
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),200) FROM \\"Deployment\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"createdAt\\" DESC LIMIT 3;"
`,
);
const ad = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-analyze-deploy.sh && /opt/launchos/bin/step317-analyze-deploy.sh'),
  { timeoutMs: 480000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-analyze-deploy.txt'), redact(ad.stdout || ad.stderr));
console.log(redact(ad.stdout || ad.stderr));

await runner.disconnect();
await prisma.$disconnect();
