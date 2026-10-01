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
const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username: resolveServerSshUsername(server.username), password: decryptCredential(server.credentialEncrypted), readyTimeoutMs: 20000 });
const r = await runner.execute(
  shellCommand(`podman logs --tail 120 launchos-alpha-api 2>&1 | sed -n 's/\\(token\\|Bearer\\|password\\|SECRET\\)[=:][^ ]*/\\1=***/gi;p' | tail -n 120`),
  { timeoutMs: 60000 },
);
const out = String(r.stdout || '').replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***').replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***');
writeFileSync(join(root, '.tools/alpha-runtime/step314-after-retest-logs.txt'), out);
console.log(out.slice(-4000));
// quick git probe inside container
const g = await runner.execute(
  shellCommand(`podman exec launchos-alpha-api /bin/sh -c 'which git; git --version; GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git master 2>&1 | head -n 5'`),
  { timeoutMs: 120000 },
);
console.log('GIT_PROBE', g.stdout, g.stderr, g.exitCode);
await runner.disconnect(); await prisma.$disconnect();
