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
const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username: resolveServerSshUsername(server.username), password: decryptCredential(server.credentialEncrypted), readyTimeoutMs: 20000 });

const logs = await runner.execute(
  shellCommand(`podman logs --since 30m launchos-alpha-api 2>&1 | grep -iE 'GitError|无法拉取|ERROR|Exception|analyze|clone|fatal' | tail -n 80`),
  { timeoutMs: 60000 },
);
console.log('LOGS', (logs.stdout || '').replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g,'***').replace(/x-access-token:[^\s@]+/gi,'x-access-token:***').slice(0,5000));

const probe = await runner.execute(
  shellCommand(`podman exec launchos-alpha-api /bin/sh -c 'which git; git --version; timeout 25 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git master; echo EC=$?'`),
  { timeoutMs: 60000 },
);
console.log('PROBE', probe.stdout, probe.stderr, probe.exitCode);

await runner.disconnect(); await prisma.$disconnect();
