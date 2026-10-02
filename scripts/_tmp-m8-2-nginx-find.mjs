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
const server = await prisma.serverInstance.findFirst({ where: { id: 'cmuma9i480001rij49yv4yw2q' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});
async function remote(cmd, timeoutMs = 90000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  console.log('>>>', cmd.slice(0, 180));
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-6000));
}
await remote('ls /www/server/panel/vhost/nginx 2>/dev/null | head; ls /www/server/nginx/conf/vhost 2>/dev/null | head; ls /etc/nginx/conf.d 2>/dev/null | head; ls /etc/nginx/sites-enabled 2>/dev/null | head');
await remote('find /www /etc/nginx /opt/launchos -name "*alpha*" 2>/dev/null | head -n 50');
await remote('grep -Rnl "alpha.zsaos.com" /www /etc/nginx /opt/launchos 2>/dev/null | head -n 30');
await remote('tail -n 50 /var/log/nginx/error.log 2>/dev/null; tail -n 50 /www/wwwlogs/*error*.log 2>/dev/null | tail -n 80');
await runner.disconnect();
await prisma.$disconnect();
