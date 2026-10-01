/**
 * Step 35 — locate current LaunchRun/Deployment for web-ceshi (1002@qq.com)
 * and previous SUCCESS run + public URL evidence.
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const TARGET_HOST = '116.62.198.184';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken|AUTH_SECRET)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
if (!server) throw new Error('alpha server missing');
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step35-locate.sql',
  `-- resolve project by owner email + name
SELECT p.id AS project_id, p.name, p.slug, u.email, u.id AS user_id
FROM "Project" p
JOIN "Workspace" w ON w.id=p."workspaceId"
JOIN "User" u ON u.id=w."ownerId"
WHERE u.email='1002@qq.com' AND (p.name ILIKE '%web-ceshi%' OR p.slug ILIKE '%web-ceshi%' OR p.name ILIKE '%ceshi%')
ORDER BY p."createdAt" DESC;

-- latest launch runs for that project (take first project id via subquery)
WITH proj AS (
  SELECT p.id FROM "Project" p
  JOIN "Workspace" w ON w.id=p."workspaceId"
  JOIN "User" u ON u.id=w."ownerId"
  WHERE u.email='1002@qq.com'
  ORDER BY CASE WHEN p.name ILIKE '%web-ceshi%' OR p.slug ILIKE '%web-ceshi%' THEN 0 ELSE 1 END, p."createdAt" DESC
  LIMIT 1
)
SELECT lr.id, lr.status, lr."currentStage"::text, lr."currentStep",
  coalesce(lr."failureCode",'') AS failure_code,
  left(coalesce(lr."failureMessage",''),200) AS failure_message,
  lr."progressPercent", lr."updatedAt", lr."createdAt",
  left(coalesce(lr."publicUrl",''),200) AS public_url
FROM "LaunchRun" lr
WHERE lr."projectId"=(SELECT id FROM proj)
ORDER BY lr."createdAt" DESC
LIMIT 8;

WITH proj AS (
  SELECT p.id FROM "Project" p
  JOIN "Workspace" w ON w.id=p."workspaceId"
  JOIN "User" u ON u.id=w."ownerId"
  WHERE u.email='1002@qq.com'
  ORDER BY CASE WHEN p.name ILIKE '%web-ceshi%' OR p.slug ILIKE '%web-ceshi%' THEN 0 ELSE 1 END, p."createdAt" DESC
  LIMIT 1
)
SELECT d.id, d.status, coalesce(d."failureCode",'') AS failure_code,
  left(coalesce(d."errorMessage",''),240) AS error_message,
  d."currentStage", d."updatedAt", d."createdAt", d."finishedAt",
  d."serviceInstanceId", d."deployableUnitId"
FROM "Deployment" d
WHERE d."projectId"=(SELECT id FROM proj)
ORDER BY d."createdAt" DESC
LIMIT 8;

WITH proj AS (
  SELECT p.id FROM "Project" p
  JOIN "Workspace" w ON w.id=p."workspaceId"
  JOIN "User" u ON u.id=w."ownerId"
  WHERE u.email='1002@qq.com'
  ORDER BY CASE WHEN p.name ILIKE '%web-ceshi%' OR p.slug ILIKE '%web-ceshi%' THEN 0 ELSE 1 END, p."createdAt" DESC
  LIMIT 1
)
SELECT si.id, si.status, si.port, si."externalPort", si."containerId",
  left(coalesce(si."imageTag",''),120) AS image_tag,
  si."updatedAt", si."createdAt",
  left(coalesce(si."publicUrl", si."url", ''),200) AS url
FROM "ServiceInstance" si
WHERE si."projectId"=(SELECT id FROM proj)
ORDER BY si."createdAt" DESC
LIMIT 8;

WITH proj AS (
  SELECT p.id FROM "Project" p
  JOIN "Workspace" w ON w.id=p."workspaceId"
  JOIN "User" u ON u.id=w."ownerId"
  WHERE u.email='1002@qq.com'
  ORDER BY CASE WHEN p.name ILIKE '%web-ceshi%' OR p.slug ILIKE '%web-ceshi%' THEN 0 ELSE 1 END, p."createdAt" DESC
  LIMIT 1
)
SELECT ad.id, ad.domain, ad.status, ad."dnsStatus", ad."sslStatus",
  ad."runtimeHost", ad."runtimePort", ad."deployableUnitId", ad."updatedAt"
FROM "ApplicationDomain" ad
WHERE ad."projectId"=(SELECT id FROM proj)
ORDER BY ad."updatedAt" DESC
LIMIT 10;

WITH proj AS (
  SELECT p.id FROM "Project" p
  JOIN "Workspace" w ON w.id=p."workspaceId"
  JOIN "User" u ON u.id=w."ownerId"
  WHERE u.email='1002@qq.com'
  ORDER BY CASE WHEN p.name ILIKE '%web-ceshi%' OR p.slug ILIKE '%web-ceshi%' THEN 0 ELSE 1 END, p."createdAt" DESC
  LIMIT 1
)
SELECT gr.id, gr.hostname, gr.status, gr."healthPath", gr."targetPort", gr."unitId", gr."updatedAt"
FROM "GatewayRoute" gr
WHERE gr."projectId"=(SELECT id FROM proj)
ORDER BY gr."updatedAt" DESC
LIMIT 10;

-- worker heartbeats
SELECT "workerId", status, "lastSeenAt",
  extract(epoch from (now() - "lastSeenAt")) AS age_sec,
  left(coalesce(meta::text,''),300) AS meta
FROM "WorkerHeartbeat"
ORDER BY "lastSeenAt" DESC
LIMIT 5;
`,
);

const sql = await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step35-locate.sql',
  'locate-sql',
);
const sqlText = redact(String(sql.stdout || ''));
writeFileSync(join(ARTIFACT_DIR, 'step35-locate.sql.txt'), sqlText);
console.log(sqlText.slice(0, 12000));

await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
