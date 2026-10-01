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

function curl(url, host) {
  const args = ['-k','-sS','-X','GET','--resolve',`${host}:443:116.62.198.184`,'-w','\n__STATUS__:%{http_code}','--max-time','30', url];
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out, err: String(r.stderr||'').slice(0,200) };
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

const script = `#!/bin/bash
set +e
echo ===LAUNCH===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),200) FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn';"
echo ===ROUTES===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT hostname, status, coalesce(\\"unitId\\",''), coalesce(\\"targetPort\\"::text,''), coalesce(\\"targetHost\\",'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY hostname;"
echo ===SI===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' AND status='RUNNING';"
echo ===NGINX===
ls /etc/nginx/conf.d/*multi-demo* 2>/dev/null; ls /etc/nginx/conf.d/*launchos* 2>/dev/null | head
grep -Rsn "launchos-multi-demo-5" /etc/nginx/conf.d 2>/dev/null | head -40
echo ===LOCAL_CURL===
curl -fsS -o /tmp/w.txt -w '%{http_code}' --resolve web-launchos-multi-demo-5.launchos.app:443:127.0.0.1 https://web-launchos-multi-demo-5.launchos.app/ ; echo
curl -fsS -o /tmp/a.txt -w '%{http_code}' --resolve api-launchos-multi-demo-5.launchos.app:443:127.0.0.1 https://api-launchos-multi-demo-5.launchos.app/health ; echo
head -c 120 /tmp/w.txt; echo; head -c 120 /tmp/a.txt; echo
echo ===WORKER_GW===
podman logs --tail 80 launchos-alpha-worker 2>&1 | grep -E 'Gateway route|VERIFY|api-launchos|web-launchos' | tail -40
`;
await runner.writeTextFile('/opt/launchos/bin/step317-verify-diag.sh', script);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/bin/step317-verify-diag.sh && /opt/launchos/bin/step317-verify-diag.sh'), { timeoutMs: 90000 });
console.log(r.stdout || r.stderr);

for (const host of ['launchos-multi-demo-5.launchos.app','web-launchos-multi-demo-5.launchos.app','api-launchos-multi-demo-5.launchos.app']) {
  const root = curl(`https://${host}/`, host);
  const health = curl(`https://${host}/health`, host);
  console.log('EXT', host, 'root', root.status, root.err || root.text.slice(0,80).replace(/\s+/g,' '), 'health', health.status, health.text.slice(0,80).replace(/\s+/g,' '));
}

await runner.disconnect();
await prisma.$disconnect();
