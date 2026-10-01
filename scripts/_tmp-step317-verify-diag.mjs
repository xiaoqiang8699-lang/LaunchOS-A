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

function curl(url, host, opts = {}) {
  const { maxTime = '30', resolveIp = '116.62.198.184' } = opts;
  const args = ['-k','-sS','--resolve',`${host}:443:${resolveIp}`,'-w','\n__STATUS__:%{http_code}','--max-time',String(maxTime),url];
  const r = spawnSync('curl.exe', args, { encoding:'utf8', maxBuffer: 4_000_000 });
  const out = String(r.stdout||'');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
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
  '/opt/launchos/bin/step317-verify-diag.sh',
  `#!/bin/bash
echo ===LAUNCH===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),200), left(coalesce(\\"planSnapshot\\"::text,''),400) FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn';"
echo ===SI===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"healthStatus\\",''), coalesce(\\"deployableUnitId\\",''), coalesce(\\"publicUrl\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"updatedAt\\" DESC LIMIT 10;"
echo ===ROUTES===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, hostname, status, coalesce(\\"unitId\\",''), coalesce(\\"targetPort\\"::text,''), coalesce(\\"healthPath\\",'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"updatedAt\\" DESC LIMIT 12;"
echo ===DOMAINS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, domain, status, coalesce(\\"dnsStatus\\",''), coalesce(\\"sslStatus\\",''), coalesce(\\"runtimeHost\\",''), coalesce(\\"runtimePort\\"::text,''), coalesce(\\"unitId\\",'') FROM \\"ApplicationDomain\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"updatedAt\\" DESC LIMIT 12;"
echo ===NGINX===
ls /etc/nginx/conf.d 2>/dev/null | head
grep -l 'launchos-multi-demo\\|zsaos.com' /etc/nginx/conf.d/*.conf 2>/dev/null | head
for f in $(grep -l 'launchos-multi-demo' /etc/nginx/conf.d/*.conf 2>/dev/null | head -5); do echo --$f--; sed -n '1,40p' "$f"; done
echo ===LOCAL_PORTS===
ss -lntp | sed -n '/:3900[0-9]/p'
echo ===CURL_LOCAL===
curl -sS -o /tmp/h.txt -w '%{http_code}' http://127.0.0.1:39006/health || true; echo; head -c 120 /tmp/h.txt; echo
curl -sS -o /tmp/w.txt -w '%{http_code}' http://127.0.0.1:39007/ || true; echo; head -c 120 /tmp/w.txt; echo
podman ps --format '{{.Names}} {{.Status}} {{.Ports}}' | sed -n '/launchos-cmun/p'
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-verify-diag.sh && /opt/launchos/bin/step317-verify-diag.sh'),
  { timeoutMs: 90000 },
);
writeFileSync(join(root, '.tools/alpha-runtime/step317-verify-diag.txt'), r.stdout || r.stderr || '');
console.log((r.stdout || r.stderr || '').slice(0, 12000));

// Probe candidate public hosts
const hosts = [];
for (const line of String(r.stdout || '').split(/\r?\n/)) {
  const m = line.match(/\b([a-z0-9.-]+\.(?:zsaos\.com|launchos\.app))\b/);
  if (m) hosts.push(m[1]);
}
const unique = [...new Set(hosts)];
console.log('HOSTS', unique);
for (const host of unique.slice(0, 8)) {
  const rootResp = curl(`https://${host}/`, host);
  const health = curl(`https://${host}/health`, host);
  console.log(JSON.stringify({ host, root: rootResp.status, health: health.status, snippet: rootResp.text.slice(0, 80).replace(/\s+/g,' ') }));
}

await runner.disconnect();
await prisma.$disconnect();
