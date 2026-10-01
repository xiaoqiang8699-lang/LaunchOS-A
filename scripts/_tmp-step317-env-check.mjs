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
  '/opt/launchos/bin/step317-env-check.sh',
  `#!/bin/bash
set -uo pipefail
echo ===CONFIG_ENV===
podman inspect launchos-alpha-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n '/^GITHUB_APP_/s/=.*$/=***/p'
echo ===FILES===
ls -la /opt/launchos/config/github-app.pem /opt/launchos/config/alpha-github.env
echo ===GITHUB_ENV_KEYS===
sed -n '/^GITHUB_APP_/s/=.*$/=***/p' /opt/launchos/config/alpha-github.env
echo ===PEM_SIZE===
wc -c /opt/launchos/config/github-app.pem
echo ===WORKER_PROC_ENV===
pid=$(podman inspect -f '{{.State.Pid}}' launchos-alpha-worker)
echo pid=$pid
tr '\\0' '\\n' < /proc/$pid/environ 2>/dev/null | sed -n '/^GITHUB_APP_/s/=.*$/=***/p' || echo no_proc_environ
`,
);

const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-env-check.sh && /opt/launchos/bin/step317-env-check.sh'),
  { timeoutMs: 30000 },
);
const out = (r.stdout || '') + (r.stderr || '');
writeFileSync(join(root, '.tools/alpha-runtime/step317-env-check.txt'), out);
console.log(out);
await runner.disconnect();
await prisma.$disconnect();
