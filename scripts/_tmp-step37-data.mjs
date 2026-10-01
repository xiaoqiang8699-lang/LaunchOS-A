/**
 * Step 37: query web-ceshi history via Alpha host (not local .env DB).
 * node scripts/_tmp-step37-data.mjs --confirm
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const sql = `#!/bin/bash
set -euo pipefail
export PGPASSWORD=$(grep -E '^DATABASE_URL=' /opt/launchos/config/alpha-api.env | head -n1 | sed -E 's|^DATABASE_URL=postgresql://[^:]+:([^@]+)@.*|\\1|')
DBURL=$(grep -E '^DATABASE_URL=' /opt/launchos/config/alpha-api.env | head -n1 | cut -d= -f2- | sed 's/^"//;s/"$//')
# parse host/db/user
USER=$(echo "$DBURL" | sed -E 's|^postgresql://([^:]+):.*|\\1|')
HOSTPORT=$(echo "$DBURL" | sed -E 's|^postgresql://[^@]+@([^/]+)/.*|\\1|')
DB=$(echo "$DBURL" | sed -E 's|^postgresql://[^/]+/([^?]+).*|\\1|')
HOST=\${HOSTPORT%%:*}
PORT=\${HOSTPORT##*:}
if [[ "$PORT" == "$HOST" ]]; then PORT=5432; fi
psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
SELECT id, name FROM "Project" WHERE name ILIKE '%web-ceshi%' OR name ILIKE '%ceshi%' ORDER BY "createdAt" DESC LIMIT 10;
SQL
PROJECT=$(psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -At -c "SELECT id FROM \\"Project\\" WHERE name='web-ceshi' ORDER BY \\"createdAt\\" DESC LIMIT 1;")
echo PROJECT=$PROJECT
psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -c "SELECT id, version, status, left(coalesce(\\"sourceRevision\\",''),7) AS rev, left(coalesce(\\"errorMessage\\",''),40) AS err, \\"createdAt\\" FROM \\"Deployment\\" WHERE \\"projectId\\"='$PROJECT' ORDER BY \\"createdAt\\" DESC LIMIT 12;"
psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -c "SELECT id, version, status, left(coalesce(\\"commitSha\\",''),7) AS sha, \\"deploymentId\\", \\"createdAt\\" FROM \\"ApplicationVersion\\" WHERE \\"projectId\\"='$PROJECT' ORDER BY \\"createdAt\\" DESC LIMIT 12;"
psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -At -c "SELECT domain, status, \\"dnsStatus\\" FROM \\"ApplicationDomain\\" WHERE domain LIKE 'web-ceshi%' ORDER BY domain;"
`;

await runner.writeTextFile('/opt/launchos/tmp/step37-data.sh', sql);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step37-data.sh && /opt/launchos/tmp/step37-data.sh'), {
  timeoutMs: 60000,
});
console.log(r.stdout || '');
if (r.exitCode !== 0) {
  console.error(String(r.stderr || '').slice(0, 2000));
  process.exit(1);
}

const projectId = (String(r.stdout || '').match(/PROJECT=([a-z0-9]+)/) || [])[1] || '';
const pc = {
  hist: spawnSync(
    'curl.exe',
    ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', `https://alpha.zsaos.com/projects/${projectId}/deployments`],
    { encoding: 'utf8' },
  ).stdout,
  vers: spawnSync(
    'curl.exe',
    ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', `https://alpha.zsaos.com/projects/${projectId}/versions`],
    { encoding: 'utf8' },
  ).stdout,
  proj: spawnSync(
    'curl.exe',
    ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', `https://alpha.zsaos.com/projects/${projectId}`],
    { encoding: 'utf8' },
  ).stdout,
};

// Confirm project page HTML/JS references the new Link hrefs (client bundle).
const bundleCheck = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-web sh -c "grep -R -l 'deployments' /app/apps/web/.next/static/chunks 2>/dev/null | head -3; grep -R -l 'viewLaunchHistory\\\\|查看上线记录\\\\|/deployments' /app/apps/web/.next/static/chunks /app/apps/web/.next/server/app/projects 2>/dev/null | head -10"`,
  ),
  { timeoutMs: 60000 },
);
console.log('BUNDLE', bundleCheck.stdout);

writeFileSync(
  join(ARTIFACT_DIR, 'step37-data.txt'),
  `${r.stdout}\n\nPC=${JSON.stringify(pc)}\nBUNDLE=${bundleCheck.stdout || ''}\n`,
);

await runner.disconnect();
await prisma.$disconnect();

const hasV15 = /\| v15\s+\| SUCCESS/.test(String(r.stdout || '')) || /\bv15\b/.test(String(r.stdout || ''));
const hasFailed = /FAILED/.test(String(r.stdout || ''));
const hasVersions = /ApplicationVersion| v1[0-9] /.test(String(r.stdout || '')) || /\| v\d+/.test(String(r.stdout || ''));
const pass =
  Boolean(projectId) &&
  Number(pc.hist) === 200 &&
  Number(pc.vers) === 200 &&
  Number(pc.proj) === 200 &&
  hasV15 &&
  hasFailed;
console.log(
  JSON.stringify(
    { projectId, pc, hasV15, hasFailed, hasVersions, pass },
    null,
    2,
  ),
);
console.log(pass ? 'STEP37_DATA=PASS' : 'STEP37_DATA=FAIL');
process.exit(pass ? 0 : 1);
