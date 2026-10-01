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
  '/opt/launchos/tmp/step34-pk-check.sh',
  `#!/bin/sh
set +e
echo 'API has PRIVATE_KEY env?'
podman exec launchos-alpha-api sh -c 'if [ -n "$GITHUB_APP_PRIVATE_KEY" ]; then echo API_PK=YES len=$(printf %s "$GITHUB_APP_PRIVATE_KEY" | wc -c); else echo API_PK=NO; fi'
echo 'WORKER has PRIVATE_KEY env?'
podman exec launchos-alpha-worker sh -c 'if [ -n "$GITHUB_APP_PRIVATE_KEY" ]; then echo WORKER_PK=YES len=$(printf %s "$GITHUB_APP_PRIVATE_KEY" | wc -c); else echo WORKER_PK=NO; fi'
echo 'WORKER pem mount?'
podman exec launchos-alpha-worker sh -c 'ls -la /run/secrets/github-app.pem 2>&1; wc -c /run/secrets/github-app.pem 2>&1'
echo 'WORKER cmdline entrypoint'
podman inspect launchos-alpha-worker --format '{{json .Config.Cmd}} {{json .Config.Entrypoint}}'
echo 'API cmdline entrypoint'
podman inspect launchos-alpha-api --format '{{json .Config.Cmd}} {{json .Config.Entrypoint}}'
`,
);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step34-pk-check.sh && /opt/launchos/tmp/step34-pk-check.sh'), {
  timeoutMs: 60000,
});
console.log(String(r.stdout || ''));
console.log(String(r.stderr || '').slice(0, 500));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
