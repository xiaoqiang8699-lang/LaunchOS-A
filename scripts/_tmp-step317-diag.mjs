import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-diag.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),500), coalesce("deployableUnitId",'')
FROM "Deployment" WHERE "projectId"='cmunhwais0003rl01wqj1qy11' ORDER BY "createdAt" DESC LIMIT 5;
SELECT id, url, branch, "isPrivate", coalesce("connectionId",''), coalesce("providerRepositoryId",'')
FROM "SourceRepository" WHERE "projectId"='cmunhwais0003rl01wqj1qy11';
SELECT d.id, ds."stepKey", ds.status, left(coalesce(ds."errorMessage",''),400)
FROM "DeploymentStep" ds JOIN "Deployment" d ON d.id=ds."deploymentId"
WHERE d."projectId"='cmunhwais0003rl01wqj1qy11'
ORDER BY d."createdAt" DESC, ds."createdAt" ASC
LIMIT 40;
`,
);
const sql = await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-diag.sql launchos-alpha-postgres:/tmp/step317-diag.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step317-diag.sql',
  ),
  { timeoutMs: 60000 },
);
console.log('SQL', redact(sql.stdout || sql.stderr));

const keys = await runner.execute(
  shellCommand("podman exec launchos-alpha-worker sh -c 'env | sed -n \"s/=.*//p\" | grep -Ei \"GITHUB|GIT_\" | sort'"),
  { timeoutMs: 20000 },
);
console.log('WORKER_KEYS', keys.stdout || keys.stderr);

const apiKeys = await runner.execute(
  shellCommand("podman exec launchos-alpha-api sh -c 'env | sed -n \"s/=.*//p\" | grep -Ei \"GITHUB|GIT_\" | sort'"),
  { timeoutMs: 20000 },
);
console.log('API_KEYS', apiKeys.stdout || apiKeys.stderr);

const logs = await runner.execute(shellCommand('podman logs --tail 120 launchos-alpha-worker'), {
  timeoutMs: 30000,
});
const text = redact(logs.stdout || logs.stderr);
writeFileSync(join(root, '.tools/alpha-runtime/step317-worker-logs.txt'), text);
console.log('WORKER_LOG_TAIL\n', text.slice(-4000));

await runner.disconnect();
await prisma.$disconnect();
