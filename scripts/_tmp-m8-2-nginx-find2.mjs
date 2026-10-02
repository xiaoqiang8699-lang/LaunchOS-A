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
async function remote(cmd, timeoutMs = 30000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  console.log('>>>', cmd.slice(0, 160));
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-7000));
}
await remote('cat /etc/nginx/conf.d/launchos-include.conf');
await remote('ls -la /etc/nginx/conf.d/; ls -la /www/server/panel/vhost/nginx/ 2>/dev/null | head -n 40');
await remote('grep -n "server_name\\|39100\\|proxy_pass\\|alpha" /etc/nginx/conf.d/* 2>/dev/null | head -n 80');
await remote('ls /www/server/panel/vhost/nginx/*.conf 2>/dev/null | head -n 40');
await remote('for f in /www/server/panel/vhost/nginx/*.conf; do grep -l "alpha.zsaos\\|39100" "$f" 2>/dev/null; done');
await remote('tail -n 30 /www/wwwlogs/alpha.zsaos.com.error.log 2>/dev/null || tail -n 30 /var/log/nginx/error.log 2>/dev/null || journalctl -u nginx -n 30 --no-pager 2>/dev/null || true');
await runner.disconnect();
await prisma.$disconnect();
