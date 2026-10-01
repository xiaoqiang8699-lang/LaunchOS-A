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
echo ===GR_COLS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT column_name FROM information_schema.columns WHERE table_name='GatewayRoute' ORDER BY ordinal_position;"
echo ===GR_ALL===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, \\"projectId\\", hostname, status FROM \\"GatewayRoute\\" ORDER BY \\"updatedAt\\" DESC LIMIT 30;"
echo ===AD===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT domain, status, coalesce(\\"deployableUnitId\\",''), coalesce(\\"runtimePort\\"::text,''), coalesce(\\"dnsStatus\\",''), coalesce(\\"sslStatus\\",'') FROM \\"ApplicationDomain\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY domain;"
echo ===NGINX_FILES===
ls -la /etc/nginx/conf.d/ | head -40
echo ===INCLUDE===
cat /etc/nginx/conf.d/launchos-include.conf 2>/dev/null | head -80
echo ===FIND_DEMO===
grep -Rsl "multi-demo-5" /etc/nginx 2>/dev/null | head
grep -Rsn "multi-demo-5" /etc/nginx 2>/dev/null | head -30
echo ===PODMAN_PORTS===
ss -lntp | grep -E '39005|39006|39007|443|80' | head
echo ===CURL127===
curl -vk --resolve web-launchos-multi-demo-5.launchos.app:443:127.0.0.1 https://web-launchos-multi-demo-5.launchos.app/ -o /tmp/w2.txt -w 'web=%{http_code}\\n' 2>&1 | tail -20
curl -vk --resolve api-launchos-multi-demo-5.launchos.app:443:127.0.0.1 https://api-launchos-multi-demo-5.launchos.app/health -o /tmp/a2.txt -w 'api=%{http_code}\\n' 2>&1 | tail -20
echo WEB_BODY=; head -c 160 /tmp/w2.txt; echo
echo API_BODY=; head -c 160 /tmp/a2.txt; echo
`;
await runner.writeTextFile('/opt/launchos/bin/step317-route-deep.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-route-deep.sh && /opt/launchos/bin/step317-route-deep.sh'),
  { timeoutMs: 90000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
