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

const inspect = await runner.execute(
  shellCommand(`
podman inspect launchos-alpha-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/=.*//p' | grep -Ei 'GITHUB|GIT_' | sort
echo ---MOUNTS---
podman inspect launchos-alpha-worker --format '{{range .Mounts}}{{.Source}}->{{.Destination}}{{println}}{{end}}'
echo ---IMAGE---
podman inspect launchos-alpha-worker --format '{{.ImageName}} {{.Config.Cmd}} {{.Config.Entrypoint}}'
echo ---PEM---
test -s /opt/launchos/config/github-app.pem && echo PEM_OK || echo PEM_MISSING
ls /opt/launchos/config/ | head
ls /opt/launchos/bin/ | head
`),
  { timeoutMs: 30000 },
);
console.log(redact(inspect.stdout || inspect.stderr));

// Recreate worker with same env-files + pem mount + entrypoint private key injection.
await runner.writeTextFile(
  '/opt/launchos/bin/step317-run-worker.sh',
  `#!/bin/bash
set -euo pipefail
NAME=launchos-alpha-worker
IMAGE=$(podman inspect "$NAME" --format '{{.ImageName}}' 2>/dev/null || true)
if [ -z "$IMAGE" ]; then
  IMAGE=$(podman images --format '{{.Repository}}:{{.Tag}}' | grep -E 'launchos.*worker|alpha-worker' | head -n 1 || true)
fi
if [ -z "$IMAGE" ]; then
  IMAGE=$(podman inspect "$NAME" --format '{{.Image}}')
fi
echo IMAGE=$IMAGE
# Capture current env files / network mode
NETWORK_MODE=$(podman inspect "$NAME" --format '{{.HostConfig.NetworkMode}}' 2>/dev/null || echo host)
echo NETWORK=$NETWORK_MODE
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" \\
  --restart unless-stopped \\
  --network host \\
  --env-file /opt/launchos/config/alpha-api.env \\
  --env-file /opt/launchos/config/alpha-github.env \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh \\
  "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; echo WORKER_BOOT_KEYS=$(env | sed -n "s/=.*//p" | grep -E "^GITHUB_APP_" | sort | tr "\\n" ","); exec node apps/worker/dist/main.js'
echo STARTED
`,
);
const recreate = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-run-worker.sh && /opt/launchos/bin/step317-run-worker.sh'),
  { timeoutMs: 120000 },
);
console.log('RECREATE', redact(recreate.stdout || recreate.stderr), 'exit', recreate.exitCode);

await new Promise((r) => setTimeout(r, 8000));
const verify = await runner.execute(
  shellCommand(`
podman ps --filter name=launchos-alpha-worker --format '{{.Names}} {{.Status}}'
podman logs --tail 40 launchos-alpha-worker 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^ ]+/\\1=***/gi'
podman exec launchos-alpha-worker sh -c 'env | sed -n "s/=.*//p" | grep -Ei "GITHUB" | sort; echo HAS_PK=$(if [ -n "$GITHUB_APP_PRIVATE_KEY" ]; then echo yes; else echo no; fi)'
`),
  { timeoutMs: 30000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-worker-fix.txt'), redact(verify.stdout || verify.stderr));
console.log(redact(verify.stdout || verify.stderr));

await runner.disconnect();
await prisma.$disconnect();
