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

const script = `#!/bin/bash
set +e
R=/tmp/launchos-repos/cmunhwais0003rl01wqj1qy11
echo ===LS===
ls -la "$R/apps/web" 2>/dev/null | head -30
echo ===PKG===
cat "$R/apps/web/package.json" 2>/dev/null
echo ===ROOTPKG===
head -80 "$R/package.json" 2>/dev/null
echo ===NM_WEB===
ls "$R/apps/web/node_modules" 2>/dev/null | head -30
echo ===NM_VITE===
ls -la "$R/node_modules/vite" 2>/dev/null | head -5
ls -la "$R/apps/web/node_modules/vite" 2>/dev/null | head -5
echo ===WORKER_ENV===
podman exec launchos-alpha-worker printenv | grep -E 'NODE_ENV|NPM_' | head
`;

await runner.writeTextFile('/opt/launchos/bin/step317-web-pkg-diag.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-web-pkg-diag.sh && /opt/launchos/bin/step317-web-pkg-diag.sh'),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
