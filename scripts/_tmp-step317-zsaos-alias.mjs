/**
 * Publish zsaos.com aliases (cert+DNS match) and update LaunchRun publicUrl.
 * node scripts/_tmp-step317-zsaos-alias.mjs --confirm-alias
 */
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
if (!process.argv.includes('--confirm-alias')) {
  console.error('pass --confirm-alias');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const LAUNCH_RUN = 'cmunhwddb0019rl01fzipihgn';
const WEB_UNIT = 'cmunhwc9k000drl01gxu1qwq2';
const API_UNIT = 'cmunhwc9g000brl01bgid72o7';
const WEB_HOST = 'web-launchos-multi-demo-5.zsaos.com';
const API_HOST = 'api-launchos-multi-demo-5.zsaos.com';
const PUBLIC_HOST = 'launchos-multi-demo-5.zsaos.com';

function redact(t) {
  return String(t || '');
}
function curl(url, host, path = '/') {
  const args = ['-sS','--resolve',`${host}:443:${TARGET_HOST}`,'-w','\n__STATUS__:%{http_code}','--max-time','30',`https://${host}${path}`];
  // no -k: require real cert trust for *.zsaos.com
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out, err: String(r.stderr || '').slice(0, 200) };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1200)}`);
  return r;
}

const si = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT coalesce(\\"deployableUnitId\\",''), coalesce(\\"externalPort\\"::text,''), id FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' AND status='RUNNING';"`,
  'si',
);
const apiPort = Number(String(si.stdout || '').split(/\r?\n/).find((l) => l.startsWith(API_UNIT + '|'))?.split('|')[1]);
const webPort = Number(String(si.stdout || '').split(/\r?\n/).find((l) => l.startsWith(WEB_UNIT + '|'))?.split('|')[1]);
const apiSi = String(si.stdout || '').split(/\r?\n/).find((l) => l.startsWith(API_UNIT + '|'))?.split('|')[2];
const webSi = String(si.stdout || '').split(/\r?\n/).find((l) => l.startsWith(WEB_UNIT + '|'))?.split('|')[2];
console.log({ apiPort, webPort, apiSi, webSi });
if (!apiPort || !webPort) throw new Error('ports missing');

for (const [hostname, port, health] of [
  [API_HOST, apiPort, '/health'],
  [WEB_HOST, webPort, '/'],
  [PUBLIC_HOST, webPort, '/'],
]) {
  await applyColocatedNginxRoute({
    host: TARGET_HOST,
    port: server.port,
    username,
    password,
    hostname,
    targetPort: port,
    healthPath: health,
  });
  console.log('nginx', hostname, port);
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-zsaos.sql',
  `INSERT INTO "ApplicationDomain" (id, "projectId", "deployableUnitId", domain, type, status, "dnsStatus", "sslStatus", "runtimeHost", "runtimePort", "createdAt", "updatedAt")
VALUES
 ('ad_api_z_${Date.now()}', '${PROJECT}', '${API_UNIT}', '${API_HOST}', 'SYSTEM', 'ACTIVE', 'ACTIVE', 'ACTIVE', '127.0.0.1', ${apiPort}, NOW(), NOW()),
 ('ad_web_z_${Date.now()}', '${PROJECT}', '${WEB_UNIT}', '${WEB_HOST}', 'SYSTEM', 'ACTIVE', 'ACTIVE', 'ACTIVE', '127.0.0.1', ${webPort}, NOW(), NOW()),
 ('ad_pub_z_${Date.now()}', '${PROJECT}', '${WEB_UNIT}', '${PUBLIC_HOST}', 'CUSTOM', 'ACTIVE', 'ACTIVE', 'ACTIVE', '127.0.0.1', ${webPort}, NOW(), NOW())
ON CONFLICT (domain) DO UPDATE SET
  "projectId"=EXCLUDED."projectId",
  "deployableUnitId"=EXCLUDED."deployableUnitId",
  status='ACTIVE', "dnsStatus"='ACTIVE', "sslStatus"='ACTIVE',
  "runtimeHost"='127.0.0.1', "runtimePort"=EXCLUDED."runtimePort", "updatedAt"=NOW();

INSERT INTO "GatewayRoute" (id, "projectId", "unitId", "serviceInstanceId", "serverInstanceId", hostname, scheme, "targetHost", "targetPort", "healthPath", status, "isDefault", "createdAt", "updatedAt")
VALUES
 ('gw_api_z_${Date.now()}', '${PROJECT}', '${API_UNIT}', '${apiSi}', '${server.id}', '${API_HOST}', 'https', '127.0.0.1', ${apiPort}, '/health', 'ACTIVE', false, NOW(), NOW()),
 ('gw_web_z_${Date.now()}', '${PROJECT}', '${WEB_UNIT}', '${webSi}', '${server.id}', '${WEB_HOST}', 'https', '127.0.0.1', ${webPort}, '/', 'ACTIVE', true, NOW(), NOW()),
 ('gw_pub_z_${Date.now()}', '${PROJECT}', '${WEB_UNIT}', '${webSi}', '${server.id}', '${PUBLIC_HOST}', 'https', '127.0.0.1', ${webPort}, '/', 'ACTIVE', true, NOW(), NOW())
ON CONFLICT (hostname) DO UPDATE SET
  "projectId"=EXCLUDED."projectId", "unitId"=EXCLUDED."unitId",
  "serviceInstanceId"=EXCLUDED."serviceInstanceId", "serverInstanceId"=EXCLUDED."serverInstanceId",
  "targetPort"=EXCLUDED."targetPort", "healthPath"=EXCLUDED."healthPath", status='ACTIVE', "updatedAt"=NOW();

UPDATE "LaunchRun" SET
  "planSnapshot"=COALESCE("planSnapshot",'{}'::jsonb) || jsonb_build_object('publicUrl', 'https://${PUBLIC_HOST}', 'platformManagedRuntime', true, 'platformManagedLabelZh', '使用 LaunchOS 测试运行资源')
WHERE id='${LAUNCH_RUN}';
`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step317-zsaos.sql launchos-alpha-postgres:/tmp/step317-zsaos.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-zsaos.sql',
  'sql',
);

await runner.writeTextFile(
  '/opt/launchos/bin/step317-zsaos-verify.sh',
  `#!/bin/bash
set +e
for pair in "${PUBLIC_HOST}|/" "${WEB_HOST}|/" "${API_HOST}|/health"; do
  host=\${pair%%|*}; path=\${pair##*|}
  code=$(curl -sS -o /tmp/zb.txt -w '%{http_code}' --resolve "$host:443:127.0.0.1" --max-time 20 "https://$host$path")
  echo "$host$path|$code|$(head -c 100 /tmp/zb.txt | tr '\\n' ' ')"
done
echo | openssl s_client -connect 127.0.0.1:443 -servername ${PUBLIC_HOST} 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null | head -10
`,
);
const v = await remoteOk('chmod 700 /opt/launchos/bin/step317-zsaos-verify.sh && /opt/launchos/bin/step317-zsaos-verify.sh', 'verify');
console.log(v.stdout);

// External strict TLS (no -k)
for (const [host, path] of [[PUBLIC_HOST, '/'], [WEB_HOST, '/'], [API_HOST, '/health']]) {
  const r = curl(`https://${host}${path}`, host, path);
  console.log('EXT', host, path, r.status, r.err || r.text.slice(0, 100).replace(/\s+/g, ' '));
}

writeFileSync(
  join(root, '.tools/alpha-runtime/step317-zsaos-alias.txt'),
  redact(JSON.stringify({ publicUrl: `https://${PUBLIC_HOST}`, apiHost: API_HOST, webHost: WEB_HOST, apiPort, webPort, verify: v.stdout }, null, 2)),
);
await runner.disconnect();
await prisma.$disconnect();
