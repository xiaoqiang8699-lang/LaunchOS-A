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
  '/opt/launchos/tmp/step35-pull-base2.sh',
  `#!/bin/bash
set +e
echo try1 docker.io
podman pull docker.io/library/node:20-alpine 2>&1 | tail -30
echo exit1=$?
echo try2 mirror
podman pull docker.m.daocloud.io/library/node:20-alpine 2>&1 | tail -30
echo exit2=$?
podman tag docker.m.daocloud.io/library/node:20-alpine node:20-alpine 2>/dev/null
podman tag docker.m.daocloud.io/library/node:20-alpine docker.io/library/node:20-alpine 2>/dev/null
echo try3 aliyun
podman pull registry.cn-hangzhou.aliyuncs.com/library/node:20-alpine 2>&1 | tail -20
echo exit3=$?
podman images | grep node | head
podman image exists node:20-alpine && echo EXISTS_SHORT || echo MISSING_SHORT
podman image exists docker.io/library/node:20-alpine && echo EXISTS_FULL || echo MISSING_FULL
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step35-pull-base2.sh && /opt/launchos/tmp/step35-pull-base2.sh'),
  { timeoutMs: 900000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
