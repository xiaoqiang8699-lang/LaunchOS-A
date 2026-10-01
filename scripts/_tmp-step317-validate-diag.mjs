import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  '/opt/launchos/bin/step317-validate-diag.sh',
  `#!/bin/sh
echo ===CONN===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"installationId\\" FROM \\"GitProviderConnection\\" WHERE id='cmump0lbq0018rl01n2beawv6'; SELECT id, \\"authStatus\\", \\"isPrivate\\" FROM \\"SourceRepository\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11';"
echo ===DEP_STEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT ds.\\"stepKey\\", ds.status, left(coalesce(ds.\\"errorMessage\\",''),300) FROM \\"DeploymentStep\\" ds WHERE ds.\\"deploymentId\\"='cmunjzrq7006prl01v6ns3k6a' ORDER BY ds.\\"order\\";"
echo ===LOGS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT left(message,300) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='cmunjzrq7006prl01v6ns3k6a' ORDER BY \\"createdAt\\" DESC LIMIT 20;"
echo ===WORKER_LOG===
podman logs --tail 80 launchos-alpha-worker
echo ===WORKER_PK===
podman exec launchos-alpha-worker /bin/sh -c 'node -e "const k=process.env.GITHUB_APP_PRIVATE_KEY||\\"\\"; console.log(\\"PK_LEN=\\"+k.length); console.log(\\"PK_BEGIN=\\"+(k.slice(0,30).replace(/\\n/g,\"\\\\n\"))); console.log(\\"APP_ID=\\"+(process.env.GITHUB_APP_ID||\\"\"));"'
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-validate-diag.sh && /opt/launchos/bin/step317-validate-diag.sh'),
  { timeoutMs: 60000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-validate-diag.txt'), redact(r.stdout || r.stderr));
console.log(redact(r.stdout || r.stderr).slice(0, 6000));

await runner.disconnect();
await prisma.$disconnect();
