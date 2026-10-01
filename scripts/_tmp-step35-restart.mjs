import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
  '/opt/launchos/tmp/step35-restart.sh',
  `#!/bin/bash
set +e
podman restart launchos-alpha-postgres
sleep 5
podman restart launchos-alpha-api launchos-alpha-worker
sleep 10
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c 'SELECT 1 as ok;'
curl -fsS http://127.0.0.1:39110/api/v1/health || echo API_DOWN
n=0
while [ "$n" -lt 30 ]; do
  n=$((n+1))
  if podman logs --tail 40 launchos-alpha-worker 2>&1 | grep -qiE 'worker ready queue=deploymentQueue'; then
    echo WORKER_OK
    exit 0
  fi
  sleep 2
done
podman logs --tail 40 launchos-alpha-worker
exit 1
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step35-restart.sh && /opt/launchos/tmp/step35-restart.sh'),
  { timeoutMs: 180000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
