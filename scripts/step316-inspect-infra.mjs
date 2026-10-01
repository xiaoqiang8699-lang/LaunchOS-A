/**
 * Step 31.6 — inspect servers/cloud for multi-demo workspace + worker status.
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
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const sql = `
SELECT id, name, host, port, scope, status, "dockerStatus", "workspaceId", provider
FROM "ServerInstance"
ORDER BY "updatedAt" DESC
LIMIT 30;

SELECT id, type, status, "providerId", "workspaceId", "projectId", "externalId", "publicIp", region, "instanceType"
FROM "CloudResource"
ORDER BY "updatedAt" DESC
LIMIT 20;

SELECT p.id, p.name, p."workspaceId"
FROM "Project" p WHERE p.id IN ('cmunhwais0003rl01wqj1qy11','cmucerx5e0001ri4w0x6sx5cz');

SELECT lr.id, lr.status,
       lr."planSnapshot"->'serverReady' AS server_ready,
       lr."planSnapshot"->'resourcesToCreate' AS to_create,
       lr."planSnapshot"->'resourcesToReuse' AS to_reuse,
       lr."planSnapshot"->'billableActions' AS billable
FROM "LaunchRun" lr
WHERE lr.id IN ('cmunhwddb0019rl01fzipihgn','cmunhwcer000irl01cs03pvgb','cmukz9yx6002irig8mb2cprvj');
`;

await runner.writeTextFile('/opt/launchos/tmp/step316-infra.sql', sql);
const db = await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step316-infra.sql launchos-alpha-postgres:/tmp/step316-infra.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step316-infra.sql',
  ),
  { timeoutMs: 60000 },
);

const worker = await runner.execute(
  shellCommand(`
echo '===CONTAINERS==='
podman ps --format '{{.Names}} {{.Status}}' | grep -E 'alpha|worker|redis|postgres' || true
echo '===WORKER_ENV_KEYS==='
podman exec launchos-alpha-worker sh -c 'env | sed -n "s/=.*//p" | grep -Ei "REDIS|QUEUE|LAUNCHOS|WORKER" | sort' 2>/dev/null || echo NO_WORKER
echo '===WORKER_HEARTBEAT==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"workerId\\", service, status, \\"lastSeenAt\\"::text, left(coalesce(meta::text,''),240) FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 5;" 2>/dev/null || true
echo '===REDIS_PING==='
podman exec launchos-alpha-redis redis-cli ping 2>/dev/null || echo NO_ALPHA_REDIS
`),
  { timeoutMs: 60000 },
);

const text = redact(`${db.stdout || ''}\n${db.stderr || ''}\n${worker.stdout || ''}\n${worker.stderr || ''}`);
writeFileSync(join(DIR, 'step316-infra.txt'), text);
console.log(text.slice(0, 14000));
await prisma.$disconnect();
