import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { resolveHostnameIpv4, verifyHostnamePointsToIp } = requireDomain('@launchos/domain');
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const HOST = 'web-ceshi.zsaos.com';
const EXPECTED_IP = '116.62.198.184';

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken|AUTH_SECRET)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: EXPECTED_IP } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

await runner.writeTextFile(
  '/opt/launchos/tmp/step36-locate.sh',
  `#!/bin/bash
set +e
echo '===DEPS==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"currentStage\\",''), coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),200), \\"createdAt\\", coalesce(\\"finishedAt\\"::text,'') FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 8;"
echo '===STEPS_LATEST==='
LATEST=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1")
echo LATEST=$LATEST
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepKey\\", status, left(coalesce(\\"errorMessage\\",''),240) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='$LATEST' ORDER BY \\"createdAt\\";"
echo '===LOGS_DNS==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT to_char(\\"createdAt\\",'HH24:MI:SS'), level, left(message,260) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='$LATEST' AND (message ILIKE '%DNS%' OR message ILIKE '%PUBLIC%' OR message ILIKE '%domain%' OR message ILIKE '%Gateway%' OR message ILIKE '%VERIFY%' OR message ILIKE '%解析%') ORDER BY \\"createdAt\\" ASC;"
echo '===LOGS_TAIL==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT to_char(\\"createdAt\\",'HH24:MI:SS'), left(message,220) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='$LATEST' ORDER BY \\"createdAt\\" DESC LIMIT 40;"
echo '===SI==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"healthStatus\\", coalesce(port::text,''), coalesce(\\"externalPort\\"::text,''), coalesce(\\"containerId\\",''), \\"createdAt\\" FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 6;"
echo '===DOMAIN==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT domain, type::text, status::text, \\"dnsStatus\\"::text, \\"sslStatus\\"::text, coalesce(\\"runtimeHost\\",''), coalesce(\\"runtimePort\\"::text,''), coalesce(\\"deployableUnitId\\",'') FROM \\"ApplicationDomain\\" WHERE \\"projectId\\"='${PROJECT}' OR domain ILIKE '%ceshi%' ORDER BY \\"updatedAt\\" DESC;"
echo '===ROUTE==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT hostname, status, \\"targetHost\\", \\"targetPort\\", \\"unitId\\" FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' OR hostname ILIKE '%ceshi%' ORDER BY \\"updatedAt\\" DESC;"
echo '===PUBLIC==='
curl -sS -o /tmp/s36b.txt -w 'public=%{http_code} ip=%{remote_ip}\\n' --max-time 20 https://${HOST}/ || echo public=FAIL
head -c 180 /tmp/s36b.txt; echo
echo '===DIG==='
dig +short ${HOST} A
dig @8.8.8.8 +short ${HOST} A
dig @1.1.1.1 +short ${HOST} A
`,
);

const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step36-locate.sh && /opt/launchos/tmp/step36-locate.sh'),
  { timeoutMs: 120000 },
);
const out = redact(String(r.stdout || '') + String(r.stderr || ''));
writeFileSync(join(ARTIFACT_DIR, 'step36-locate.txt'), out);
console.log(out);

const doh = await resolveHostnameIpv4(HOST);
const match = await verifyHostnamePointsToIp(HOST, EXPECTED_IP);
writeFileSync(join(ARTIFACT_DIR, 'step36-dns.json'), JSON.stringify({ doh, match }, null, 2));
console.log('DOH', JSON.stringify({ doh, match }, null, 2));

const ext = spawnSync(
  'curl.exe',
  ['-sS', '--max-time', '25', '-w', '\nCODE:%{http_code}\nIP:%{remote_ip}\n', `https://${HOST}/`],
  { encoding: 'utf8', maxBuffer: 2_000_000 },
);
writeFileSync(
  join(ARTIFACT_DIR, 'step36-external.json'),
  JSON.stringify(
    {
      code: Number((String(ext.stdout || '').match(/CODE:(\d+)/) || [])[1] || 0),
      ip: (String(ext.stdout || '').match(/IP:([^\n]+)/) || [])[1] || null,
      body: String(ext.stdout || '').replace(/\nCODE:[\s\S]*$/, '').replace(/\s+/g, ' ').slice(0, 200),
      stderr: String(ext.stderr || '').slice(0, 200),
    },
    null,
    2,
  ),
);
console.log('EXTERNAL', readFileSync(join(ARTIFACT_DIR, 'step36-external.json'), 'utf8'));

await runner.disconnect();
await prisma.$disconnect();
