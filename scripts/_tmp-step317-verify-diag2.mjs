import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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

function curl(url, host) {
  const args = ['-k','-sS','--resolve',`${host}:443:116.62.198.184`,'-w','\n__STATUS__:%{http_code}','--max-time','30',url];
  const r = spawnSync('curl.exe', args, { encoding:'utf8', maxBuffer: 4_000_000 });
  const out = String(r.stdout||'');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: (m ? out.slice(0, m.index) : out).slice(0, 200) };
}

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
  '/opt/launchos/bin/step317-verify-diag2.sh',
  `#!/bin/bash
set +e
P=cmunhwais0003rl01wqj1qy11
echo ===SI===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"containerId\\",''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='$P' ORDER BY \\"updatedAt\\" DESC LIMIT 10;"
echo EXIT:$?
echo ===ROUTES===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, hostname, status, coalesce(\\"unitId\\",'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='$P' ORDER BY \\"updatedAt\\" DESC LIMIT 12;"
echo EXIT:$?
echo ===DOMAINS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, domain, status, coalesce(\\"dnsStatus\\",''), coalesce(\\"sslStatus\\",''), coalesce(\\"unitId\\",'') FROM \\"ApplicationDomain\\" WHERE \\"projectId\\"='$P' ORDER BY \\"updatedAt\\" DESC LIMIT 12;"
echo EXIT:$?
echo ===DEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"deployableUnitId\\",''), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='$P' ORDER BY \\"createdAt\\" DESC LIMIT 6;"
echo ===UNITS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, type::text, name FROM \\"DeployableUnit\\" WHERE \\"projectId\\"='$P';"
echo ===PODS===
podman ps -a --format '{{.Names}} {{.Status}} {{.Ports}}' | sed -n '/launchos-cmun\\|3900/p'
echo ===NGINX_GREP===
grep -RIn 'launchos-multi-demo\\|39006\\|39007' /etc/nginx/conf.d 2>/dev/null | head -40
echo ===CURL===
curl -sS -m 5 -o /tmp/a.txt -w 'api_local:%{http_code}\\n' http://127.0.0.1:39006/health
cat /tmp/a.txt; echo
for p in 39005 39006 39007 39008; do code=$(curl -sS -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:$p/ || true); echo port_$p:$code; done
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-verify-diag2.sh && /opt/launchos/bin/step317-verify-diag2.sh'),
  { timeoutMs: 90000 },
);
const out = r.stdout || r.stderr || '';
writeFileSync(join(root, '.tools/alpha-runtime/step317-verify-diag2.txt'), out);
console.log(out.slice(0, 14000));

const hosts = [...new Set(
  out.split(/\r?\n/).flatMap((line) => {
    const ms = [...line.matchAll(/([a-z0-9.-]+\.(?:zsaos\.com|launchos\.app))/g)];
    return ms.map((m) => m[1]);
  }),
)];
console.log('HOSTS', hosts);
for (const host of hosts) {
  console.log(JSON.stringify({ host, root: curl(`https://${host}/`, host), health: curl(`https://${host}/health`, host) }));
}

await runner.disconnect();
await prisma.$disconnect();
