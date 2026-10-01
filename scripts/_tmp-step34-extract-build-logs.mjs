/**
 * Step 34 — extract real npm/docker build stderr for Deployment cmunvd5xl0015rl01xbv001ex
 * node scripts/_tmp-step34-extract-build-logs.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const DEP = 'cmunvd5xl0015rl01xbv001ex';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|x-access-token)[=:]\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
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

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-extract.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),500), coalesce("deployableUnitId",''), coalesce("artifactId",'')
FROM "Deployment" WHERE id='${DEP}';

SELECT "stepKey", status, left(coalesce("errorMessage",''),800), coalesce("startedAt"::text,''), coalesce("finishedAt"::text,'')
FROM "DeploymentStep" WHERE "deploymentId"='${DEP}' ORDER BY "createdAt";

SELECT left(message,1200) FROM "DeploymentLog" WHERE "deploymentId"='${DEP}' ORDER BY "createdAt" ASC LIMIT 120;

SELECT id, name, type::text, coalesce("rootPath",''), coalesce(framework,'') FROM "DeployableUnit" WHERE "projectId"='${PROJECT}';
`,
);

const sql = await runner.execute(
  shellCommand(
    'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step34-extract.sql',
  ),
  { timeoutMs: 60000 },
);

const workerLogs = await runner.execute(
  shellCommand(
    `podman logs --tail 300 launchos-alpha-worker 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,}|x-access-token)[=:][^ ]+/\\1=***/gi' | grep -E '${DEP}|npm install|npm ERR|ERESOLVE|ENOENT|exit code|docker build|REMOTE_DEPLOY|AUTH_SECRET|package-lock|pnpm|yarn' | tail -120`,
  ),
  { timeoutMs: 60000 },
);

const apiLogs = await runner.execute(
  shellCommand(
    `podman logs --tail 200 launchos-alpha-api 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,})[=:][^ ]+/\\1=***/gi' | grep -E '${DEP}|DEPLOYMENT_TIMEOUT|REMOTE_DEPLOY|npm' | tail -60`,
  ),
  { timeoutMs: 60000 },
);

// Try to find build workspace leftovers / docker build cache notes on host
const hostProbe = await runner.execute(
  shellCommand(
    `ls -la /tmp/launchos-repos/${PROJECT} 2>/dev/null | head -40; ls -la /tmp/launchos-build* 2>/dev/null | head -20; find /tmp -maxdepth 3 -type f -name 'npm-debug.log*' 2>/dev/null | head -10; find /var/tmp /tmp -maxdepth 4 -type d -name '*cmunvd5*' 2>/dev/null | head -10`,
  ),
  { timeoutMs: 60000 },
);

const out = {
  sql: redact(String(sql.stdout || '')),
  workerLogs: redact(String(workerLogs.stdout || '')),
  apiLogs: redact(String(apiLogs.stdout || '')),
  hostProbe: redact(String(hostProbe.stdout || '') + String(hostProbe.stderr || '')).slice(0, 4000),
};
writeFileSync(join(ARTIFACT_DIR, 'step34-extract.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
await runner.disconnect();
