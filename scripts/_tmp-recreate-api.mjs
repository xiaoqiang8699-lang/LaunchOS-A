import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

const LIVE = 'launchos-alpha-api';
const PORT = 39110;
const IMAGE = 'localhost/launchos-alpha-api:step314';

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

// Ensure run script exists (rewrite clean)
const runScript = `#!/bin/bash
set -euo pipefail
NAME="$1"
PORT="$2"
IMAGE="$3"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" \\
  --restart unless-stopped \\
  --network host \\
  --env-file /opt/launchos/config/alpha-api.env \\
  --env-file /opt/launchos/config/alpha-github.env \\
  -e "API_PORT=$PORT" \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh \\
  "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/api/dist/main.js'
echo STARTED
`;
await runner.writeTextFile('/opt/launchos/bin/step314-run-api.sh', runScript);
await runner.execute(shellCommand('chmod 700 /opt/launchos/bin/step314-run-api.sh'), { timeoutMs: 15000 });

const recreate = await runner.execute(
  shellCommand(`/opt/launchos/bin/step314-run-api.sh ${LIVE} ${PORT} ${IMAGE} && sleep 4 && podman ps --filter name=${LIVE} --format '{{.Names}} {{.Status}}' && podman exec ${LIVE} /bin/sh -c 'echo SH_OK; ls /bin/sh; grep -n http.version=HTTP/1.1 /app/packages/git/dist/git.service.js | head -n1; grep -n resolveAuthForSource /app/apps/api/dist/analyses/analyses.service.js | head -n1; grep -n GitHubConnectionsModule /app/apps/api/dist/analyses/analyses.module.js | head -n1' && curl -sS -m 15 http://127.0.0.1:${PORT}/api/v1/health`),
  { timeoutMs: 180000 },
);
console.log('EXIT', recreate.exitCode);
console.log('OUT', recreate.stdout);
console.log('ERR', recreate.stderr);

await runner.disconnect();
await prisma.$disconnect();
process.exit(recreate.exitCode === 0 && /SH_OK/.test(recreate.stdout || '') ? 0 : 1);
