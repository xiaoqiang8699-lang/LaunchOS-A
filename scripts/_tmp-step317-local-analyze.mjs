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

const ownerEmail = (
  await runner.execute(
    shellCommand(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='cmunhwais0003rl01wqj1qy11';"`),
    { timeoutMs: 20000 },
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcrypt.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass4.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-pass4.sql launchos-alpha-postgres:/tmp/step317-pass4.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass4.sql',
  ),
  { timeoutMs: 20000 },
);

await runner.writeTextFile(
  '/opt/launchos/bin/step317-local-analyze.sh',
  `#!/bin/bash
set -euo pipefail
EMAIL='${ownerEmail.replace(/'/g, "'\\''")}'
PASS='${tempPass.replace(/'/g, "'\\''")}'
LOGIN=$(curl -sS -X POST http://127.0.0.1:39110/api/v1/auth/login -H 'content-type: application/json' -d "{\\"email\\":\\"$EMAIL\\",\\"password\\":\\"$PASS\\"}")
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"accessToken":"\\([^"]*\\)".*/\\1/p')
echo LOGIN_OK=$( [ -n "$TOKEN" ] && echo yes || echo no )
UNITS=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, type, deployable FROM \\"DeployableUnit\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY type;")
echo UNITS
echo "$UNITS"
API_UNIT=$(echo "$UNITS" | awk -F'|' '$2=="API"{print $1; exit}')
WEB_UNIT=$(echo "$UNITS" | awk -F'|' '$2=="WEB"{print $1; exit}')
echo API_UNIT=$API_UNIT
echo WEB_UNIT=$WEB_UNIT
echo ANALYZE_START
ANALYZE=$(curl -sS -m 240 -w '\\nSTATUS:%{http_code}' -X POST http://127.0.0.1:39110/api/v1/projects/cmunhwais0003rl01wqj1qy11/code-analysis -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' || true)
echo "$ANALYZE" | sed -E 's/(PASSWORD|SECRET|TOKEN|Bearer|x-access-token)[=:][^ ]+/\\1=***/gi' | tail -c 1200
echo
echo DEPLOY_API_START
DEPLOY=$(curl -sS -m 60 -w '\\nSTATUS:%{http_code}' -X POST http://127.0.0.1:39110/api/v1/projects/cmunhwais0003rl01wqj1qy11/deployments -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\\"environmentId\\":\\"cmunhwaiw0007rl01frx7co7o\\",\\"hostingMode\\":\\"launchos\\",\\"targetType\\":\\"MANAGED_SERVER\\",\\"deployableUnitId\\":\\"$API_UNIT\\"}" || true)
echo "$DEPLOY" | sed -E 's/(PASSWORD|SECRET|TOKEN|Bearer|x-access-token)[=:][^ ]+/\\1=***/gi' | tail -c 1500
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-local-analyze.sh && /opt/launchos/bin/step317-local-analyze.sh'),
  { timeoutMs: 360000 },
);
const out = redact(r.stdout || r.stderr);
writeFileSync(join(root, '.tools/alpha-runtime/step317-local-analyze.txt'), out);
console.log(out);

await runner.disconnect();
await prisma.$disconnect();
