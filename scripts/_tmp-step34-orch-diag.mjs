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
  '/opt/launchos/tmp/step34-orch-diag.sh',
  `#!/bin/sh
set +e
echo '=== heartbeats ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT \\"workerId\\", status, \\"lastSeenAt\\", left(coalesce(meta::text,''),200) FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 5;"
echo
echo '=== launch run detail ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT id, status, \\"failureCode\\", left(coalesce(\\"failureMessage\\",''),300), \\"updatedAt\\" FROM \\"LaunchRun\\" WHERE id IN ('cmunxrbyc000vrl0170al164h','cmunxpuh70003rl017dqwkuj5','cmunxlufh0003rl01zdcfkgkz');"
echo
echo '=== deployments last 10 min ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT id, status, \\"failureCode\\", \\"createdAt\\" FROM \\"Deployment\\" WHERE \\"projectId\\"='cmunsm2lk00ctrl01nnu1pwyd' ORDER BY \\"createdAt\\" DESC LIMIT 8;"
echo
echo '=== api logs filtered ==='
podman logs --since 10m launchos-alpha-api 2>&1 | grep -iE 'cmunxrbyc|cmunxpuh|NO_DEPLOYMENT|GitHub|deployment|error|Error|WORKER|BUILD_UNIT|enqueue' | sed -E 's/gh[pousr]_[A-Za-z0-9_]{20,}/***/g; s/Bearer [A-Za-z0-9._-]+/Bearer ***/g' | tail -80
echo
echo '=== worker logs filtered ==='
podman logs --since 10m launchos-alpha-worker 2>&1 | grep -iE 'cmunxrbyc|cmunxpuh|cmunxlwnr|GitHub|Deployment|error|Error|accepted|failed' | sed -E 's/gh[pousr]_[A-Za-z0-9_]{20,}/***/g' | tail -80
`,
);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step34-orch-diag.sh && /opt/launchos/tmp/step34-orch-diag.sh'), {
  timeoutMs: 120000,
});
const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-orch-diag.txt'), out);
console.log(out.slice(0, 12000));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
