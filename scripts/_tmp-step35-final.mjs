import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const DEP = 'cmuo3p33x0015rl01ny0yo4t6';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';

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
  '/opt/launchos/tmp/step35-final.sh',
  `#!/bin/bash
set +e
echo '===DEP==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", coalesce(\\"failureCode\\",''), coalesce(\\"uploadStatus\\"::text,'') FROM \\"Deployment\\" WHERE id='${DEP}';"
echo '===SI==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"healthStatus\\", coalesce(port::text,''), coalesce(\\"externalPort\\"::text,''), coalesce(\\"internalPort\\"::text,''), coalesce(\\"containerId\\",''), coalesce(\\"imageTag\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 3;"
echo '===DOMAIN==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT domain, status, \\"dnsStatus\\", \\"sslStatus\\", coalesce(\\"runtimePort\\"::text,'') FROM \\"ApplicationDomain\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC;"
echo '===ROUTE==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT hostname, status, \\"targetPort\\", \\"targetHost\\" FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}';"
echo '===LAUNCH==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"currentStage\\",''), \\"createdAt\\" FROM \\"LaunchRun\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 3;"
echo '===AUTH_PRESENT==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT CASE WHEN EXISTS (SELECT 1 FROM \\"RuntimeConfigItem\\" r JOIN \\"RuntimeConfigSet\\" s ON s.id=r.\\"configSetId\\" WHERE s.\\"projectId\\"='${PROJECT}' AND r.key='AUTH_SECRET') THEN 'true' ELSE 'false' END;"
echo '===CONTAINER==='
podman ps -a --filter name=launchos-cmuo3p33x0 --format '{{.ID}} {{.Names}} {{.Status}} {{.Ports}}'
podman inspect launchos-cmuo3p33x0 --format 'State={{.State.Status}} Exit={{.State.ExitCode}} OOM={{.State.OOMKilled}} Started={{.State.StartedAt}} Cmd={{json .Config.Cmd}} EnvHOST={{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | head -40
echo '===LOGS==='
podman logs --tail 30 launchos-cmuo3p33x0 2>&1 | tail -30
echo '===WORKER==='
podman logs --tail 15 launchos-alpha-worker 2>&1 | tail -15
echo '===CURL==='
curl -sS -k -o /tmp/s35b.txt -w 'public=%{http_code} ip=%{remote_ip}\\n' --max-time 20 https://web-ceshi.zsaos.com/
head -c 160 /tmp/s35b.txt; echo
curl -sS -o /dev/null -w 'loopback=%{http_code}\\n' --max-time 10 http://127.0.0.1:39008/
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step35-final.sh && /opt/launchos/tmp/step35-final.sh'),
  { timeoutMs: 120000 },
);
writeFileSync(join(ARTIFACT_DIR, 'step35-final.txt'), String(r.stdout || '') + String(r.stderr || ''));
console.log(r.stdout || r.stderr);

const external = spawnSync(
  'curl.exe',
  ['-k', '-sS', '-L', '--max-time', '30', '-w', '\nCODE:%{http_code}\nIP:%{remote_ip}\n', 'https://web-ceshi.zsaos.com/'],
  { encoding: 'utf8', maxBuffer: 2_000_000 },
);
writeFileSync(
  join(ARTIFACT_DIR, 'step35-external-final.json'),
  JSON.stringify(
    {
      code: Number((String(external.stdout || '').match(/CODE:(\d+)/) || [])[1] || 0),
      ip: (String(external.stdout || '').match(/IP:([^\n]+)/) || [])[1] || null,
      body: String(external.stdout || '')
        .replace(/\nCODE:[\s\S]*$/, '')
        .replace(/\s+/g, ' ')
        .slice(0, 200),
      stderr: String(external.stderr || '').slice(0, 200),
    },
    null,
    2,
  ),
);

await runner.disconnect();
await prisma.$disconnect();
