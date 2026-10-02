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
const r = await runner.execute(
  shellCommand(
    [
      'nginx -t 2>&1 | tail -n 5 || /www/server/nginx/sbin/nginx -t 2>&1 | tail -n 5 || true',
      'grep -R "39100\\|alpha.zsaos" /www/server/panel/vhost/nginx /etc/nginx 2>/dev/null | head -n 40 || true',
      'curl -sS -o /dev/null -w "local:%{http_code}\\n" --max-time 5 http://127.0.0.1:39100/billing',
      'curl -sS -o /dev/null -w "host:%{http_code}\\n" --max-time 5 -H "Host: alpha.zsaos.com" https://127.0.0.1/billing -k || true',
    ].join('; echo ====; '),
  ),
  { timeoutMs: 60000 },
);
console.log((r.stdout || '') + (r.stderr || ''));
await runner.disconnect();
await prisma.$disconnect();
