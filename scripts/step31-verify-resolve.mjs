/**
 * Verify Alpha gateway via direct IP Host-header / --resolve (bypass local fake-ip DNS).
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env')]) {
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
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');

const TARGET = '116.62.198.184';
const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET } });
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);

// Re-apply gateway routes
const gw = {
  api: await applyColocatedNginxRoute({
    host: TARGET,
    port: server.port,
    username,
    password,
    hostname: 'api-alpha.zsaos.com',
    targetPort: 39110,
    healthPath: '/api/v1/health',
  }),
  web: await applyColocatedNginxRoute({
    host: TARGET,
    port: server.port,
    username,
    password,
    hostname: 'alpha.zsaos.com',
    targetPort: 39111,
    healthPath: '/',
  }),
};
console.log('gateway', gw);

const runner = new RemoteRunner();
await runner.connect({ host: TARGET, port: server.port, username, password });
const conf = await runner.execute(
  shellCommand(
    "grep -E 'server_name (alpha|api-alpha)' /opt/launchos/gateway/active/launchos-routes.conf; echo ---; curl -fsS -o /tmp/w.html -w 'LOCAL_WEB:%{http_code}\\n' -H 'Host: alpha.zsaos.com' http://127.0.0.1:39111/; curl -fsS -w 'LOCAL_API:%{http_code}\\n' http://127.0.0.1:39110/api/v1/health; curl -k -fsS -o /tmp/w2.html -w 'NGINX_WEB:%{http_code}\\n' --resolve alpha.zsaos.com:443:127.0.0.1 https://alpha.zsaos.com/; curl -k -fsS -w 'NGINX_API:%{http_code} ' --resolve api-alpha.zsaos.com:443:127.0.0.1 https://api-alpha.zsaos.com/api/v1/health; echo; head -c 200 /tmp/w2.html; echo",
  ),
  { timeoutMs: 60000 },
);
console.log(conf.stdout);
console.log('stderr', conf.stderr);

await runner.disconnect();
await prisma.$disconnect();

// From builder machine: curl --resolve to real IP (ignore fake-ip DNS)
function curlResolve(url, host, ip) {
  const args = ['-k', '-sS', '-o', '-', '-w', '\\nHTTP:%{http_code}\\n', '--resolve', `${host}:443:${ip}`, url];
  const r = spawnSync('curl.exe', args, { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').slice(0, 400), err: (r.stderr || '').slice(0, 200) };
}
console.log('builder_web', curlResolve('https://alpha.zsaos.com/', 'alpha.zsaos.com', TARGET));
console.log(
  'builder_api',
  curlResolve('https://api-alpha.zsaos.com/api/v1/health', 'api-alpha.zsaos.com', TARGET),
);
