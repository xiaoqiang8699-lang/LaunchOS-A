import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

const r = await runner.execute(
  shellCommand(`echo '===WEB==='; podman ps -a --filter name=launchos-alpha-web --format '{{.Names}} {{.Status}} {{.Ports}} {{.Image}}'; echo '===PORTS==='; ss -lntp | grep -E ':39002|:39082|:3000' | head; echo '===NGINX_ALPHA==='; grep -RIn 'alpha.zsaos.com' /opt/launchos/gateway/active /etc/nginx 2>/dev/null | head -40; echo '===UPSTREAM_SNIPPET==='; awk '/server_name alpha\\.zsaos\\.com/,/}/' /opt/launchos/gateway/active/launchos-routes.conf 2>/dev/null | head -80; echo '===CURL_WEB==='; curl -sS -m 5 -o /dev/null -w 'web39082=%{http_code}\\n' http://127.0.0.1:39082/ || echo web39082=FAIL; curl -sS -m 5 -o /dev/null -w 'web39002=%{http_code}\\n' http://127.0.0.1:39002/ || echo web39002=FAIL; curl -sS -k -m 8 -o /dev/null -w 'alpha_https=%{http_code}\\n' --resolve alpha.zsaos.com:443:127.0.0.1 https://alpha.zsaos.com/ || echo alpha_https=FAIL; curl -sS -m 5 http://127.0.0.1:39110/api/v1/health || echo api=FAIL`),
  { timeoutMs: 90000 },
);
console.log(r.stdout || r.stderr);

const ext = spawnSync('curl.exe', ['-k','-sS','-m','20','-w','\nHTTP:%{http_code}\n','https://alpha.zsaos.com/dashboard'], { encoding: 'utf8' });
console.log('FROM_PC', ext.stdout?.slice(0,300), ext.stderr?.slice(0,200));

await runner.disconnect();
await prisma.$disconnect();
