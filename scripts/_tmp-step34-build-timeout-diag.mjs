import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const DEP = 'cmunxufp8002lrl01jhh3sqt7';

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
  '/opt/launchos/tmp/step34-build-timeout-diag.sh',
  `#!/bin/sh
set +e
echo '=== steps ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT \\"stepKey\\", status, \\"startedAt\\", \\"finishedAt\\", left(coalesce(\\"errorMessage\\",''),200) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='${DEP}' ORDER BY \\"createdAt\\";"
echo
echo '=== all logs ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT \\"createdAt\\", level, left(message,300) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${DEP}' ORDER BY \\"createdAt\\" ASC LIMIT 80;"
echo
echo '=== worker logs ==='
podman logs --since 20m launchos-alpha-worker 2>&1 | grep -iE '${DEP}|npm install|timeout|prisma|BUILD_APPLICATION|命令超时|Image archive|REMOTE' | sed -E 's/gh[pousr]_[A-Za-z0-9_]{20,}/***/g' | tail -100
echo
echo '=== deployment row ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT id, status, \\"failureCode\\", left(coalesce(\\"errorMessage\\",''),400), \\"startedAt\\", \\"finishedAt\\" FROM \\"Deployment\\" WHERE id='${DEP}';"
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step34-build-timeout-diag.sh && /opt/launchos/tmp/step34-build-timeout-diag.sh'),
  { timeoutMs: 120000 },
);
const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-build-timeout-diag.txt'), out);
console.log(out.slice(0, 14000));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
