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
echo ===FIND===
podman exec launchos-alpha-worker sh -lc 'find /app -name "deployment-engine*" 2>/dev/null | head -40'
echo ===PKG===
podman exec launchos-alpha-worker sh -lc 'ls -la /app/packages/deployment/dist/engine 2>/dev/null | head; ls -la /app/node_modules/@launchos/deployment 2>/dev/null | head'
echo ===GREP===
podman exec launchos-alpha-worker sh -lc 'rg -n "env: buildEnv" /app/packages/deployment/dist -g "*.js" 2>/dev/null | head; grep -Rsn "env: buildEnv" /app/packages/deployment/dist 2>/dev/null | head; grep -Rsn "npm install" /app/packages/deployment/dist/engine 2>/dev/null | head'
`;
await runner.writeTextFile('/opt/launchos/bin/step317-find-engine.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-find-engine.sh && /opt/launchos/bin/step317-find-engine.sh'),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
