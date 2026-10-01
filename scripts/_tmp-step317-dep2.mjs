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
  '/opt/launchos/tmp/step317-dep2.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),400), "createdAt"::text, coalesce("deployableUnitId",'')
FROM "Deployment" WHERE "projectId"='cmunhwais0003rl01wqj1qy11' ORDER BY "createdAt" DESC LIMIT 8;
SELECT ds."deploymentId", ds."stepKey", ds.status, left(coalesce(ds."errorMessage",''),300)
FROM "DeploymentStep" ds
WHERE ds."deploymentId" IN (
  SELECT id FROM "Deployment" WHERE "projectId"='cmunhwais0003rl01wqj1qy11' ORDER BY "createdAt" DESC LIMIT 2
)
ORDER BY ds."deploymentId", ds."order";
SELECT id, left(message,300), "createdAt"::text FROM "DeploymentLog"
WHERE "deploymentId" IN (
  SELECT id FROM "Deployment" WHERE "projectId"='cmunhwais0003rl01wqj1qy11' ORDER BY "createdAt" DESC LIMIT 1
)
ORDER BY "createdAt" DESC LIMIT 20;
`,
);
const sql = await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step317-dep2.sql launchos-alpha-postgres:/tmp/step317-dep2.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step317-dep2.sql',
  ),
  { timeoutMs: 60000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-dep2.txt'), redact(sql.stdout || sql.stderr));
console.log(redact(sql.stdout || sql.stderr));

await runner.disconnect();
await prisma.$disconnect();
