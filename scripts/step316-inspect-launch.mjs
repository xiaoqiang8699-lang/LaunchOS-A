/**
 * Step 31.6 — inspect LaunchRun / plan cost gate for launchos-multi-demo (no secrets).
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

const DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|authorization)[=:\s][^\s"']+/gi, '$1=***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
if (!server) throw new Error('server missing');
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const sql = `
-- latest launch runs for multi-demo
SELECT lr.id, lr.status, lr."planVersion", lr."environmentId", lr."projectId", lr."createdAt"::text,
       p.name,
       e.name AS env_name,
       (SELECT s.id FROM "SourceRepository" s WHERE s."projectId"=p.id ORDER BY s."createdAt" DESC LIMIT 1) AS source_id,
       (SELECT s.url FROM "SourceRepository" s WHERE s."projectId"=p.id ORDER BY s."createdAt" DESC LIMIT 1) AS source_url
FROM "LaunchRun" lr
JOIN "Project" p ON p.id=lr."projectId"
JOIN "ProjectEnvironment" e ON e.id=lr."environmentId"
WHERE p.id='cmunhwais0003rl01wqj1qy11'
   OR EXISTS (
     SELECT 1 FROM "SourceRepository" s
     WHERE s."projectId"=p.id AND s.url ILIKE '%launchos-multi-demo%'
   )
ORDER BY lr."createdAt" DESC
LIMIT 10;

-- steps for latest known plan run
SELECT "stepType", status, decision, "resourceType", "executionOrder",
       left(coalesce("metadataJson"::text,''), 160) AS meta
FROM "LaunchStep"
WHERE "launchRunId"='cmunhwcer000irl01cs03pvgb'
ORDER BY "executionOrder";

-- plan snapshot summary keys
SELECT lr.id, lr.status,
       lr."planSnapshot"->'serverReady' AS server_ready,
       lr."planSnapshot"->'requiresConfirmation' AS requires_confirmation,
       lr."planSnapshot"->'canLaunch' AS can_launch,
       lr."planSnapshot"->'resourcesToCreate' AS resources_to_create,
       lr."planSnapshot"->'resourcesToReuse' AS resources_to_reuse,
       lr."planSnapshot"->'billableActions' AS billable_actions,
       lr."planSnapshot"->'blockers' AS blockers
FROM "LaunchRun" lr
WHERE lr.id='cmunhwcer000irl01cs03pvgb';

-- workspace servers / cloud resources for that project workspace
SELECT si.id, si.host, si.status, si."workspaceId", left(coalesce(si.label,''),40)
FROM "ServerInstance" si
WHERE si."workspaceId" = (
  SELECT "workspaceId" FROM "Project" WHERE id='cmunhwais0003rl01wqj1qy11'
)
ORDER BY si."updatedAt" DESC
LIMIT 10;

SELECT cr.id, cr.type, cr.status, cr.provider, left(coalesce(cr.name,''),40)
FROM "CloudResource" cr
WHERE cr."workspaceId" = (
  SELECT "workspaceId" FROM "Project" WHERE id='cmunhwais0003rl01wqj1qy11'
)
ORDER BY cr."updatedAt" DESC
LIMIT 20;
`;

await runner.writeTextFile('/opt/launchos/tmp/step316-inspect.sql', sql);
const out = await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step316-inspect.sql launchos-alpha-postgres:/tmp/step316-inspect.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step316-inspect.sql',
  ),
  { timeoutMs: 60000 },
);
const text = redact(`${out.stdout || ''}\n${out.stderr || ''}`);
writeFileSync(join(DIR, 'step316-inspect.txt'), text);
console.log(text.slice(0, 12000));
await prisma.$disconnect();
