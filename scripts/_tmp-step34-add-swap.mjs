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
  '/opt/launchos/tmp/step34-add-swap.sh',
  `#!/bin/bash
set -euo pipefail
if swapon --show | grep -q .; then
  echo SWAP_ALREADY
  free -h
  exit 0
fi
if [ ! -f /opt/launchos/swapfile ]; then
  fallocate -l 4G /opt/launchos/swapfile || dd if=/dev/zero of=/opt/launchos/swapfile bs=1M count=4096
  chmod 600 /opt/launchos/swapfile
  mkswap /opt/launchos/swapfile
fi
swapon /opt/launchos/swapfile
free -h
swapon --show
echo SWAP_OK
`,
);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step34-add-swap.sh && /opt/launchos/tmp/step34-add-swap.sh'), {
  timeoutMs: 180000,
});
console.log(String(r.stdout || ''));
console.log(String(r.stderr || '').slice(0, 500));
console.log('exit', r.exitCode);
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
process.exit(r.exitCode === 0 ? 0 : 1);
