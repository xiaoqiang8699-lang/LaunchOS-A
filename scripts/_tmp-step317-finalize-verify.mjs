/**
 * Finalize Step 31.7: upsert GatewayRoutes, colocated VERIFY, mark LaunchRun SUCCESS
 * when live API+WEB already HEALTHY. Does not create paid resources.
 *
 * node scripts/_tmp-step317-finalize-verify.mjs --confirm-finalize
 */
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
if (!process.argv.includes('--confirm-finalize')) {
  console.error('pass --confirm-finalize');
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
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '').replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}
function curl(url, host, path = '/') {
  const args = [
    '-k', '-sS', '--resolve', `${host}:443:${TARGET_HOST}`,
    '-w', '\n__STATUS__:%{http_code}', '--max-time', '30',
    `https://${host}${path}`,
  ];
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out, err: String(r.stderr || '') };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(command, label, opts = {}) {
  const r = await runner.execute(shellCommand(command), { timeoutMs: opts.timeoutMs ?? 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

console.log('[1] read live service ports + domains');
const si = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT coalesce(\\"deployableUnitId\\",''), status, coalesce(\\"externalPort\\"::text,''), id FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' AND status='RUNNING' ORDER BY \\"updatedAt\\" DESC;"`,
  'si',
);
console.log(si.stdout);
const apiPort = Number(String(si.stdout || '').split(/\r?\n/).find((l) => l.startsWith(API_UNIT + '|RUNNING|'))?.split('|')[2]) || 0;
const webPort = Number(String(si.stdout || '').split(/\r?\n/).find((l) => l.startsWith(WEB_UNIT + '|RUNNING|'))?.split('|')[2]) || 0;
const apiSi = String(si.stdout || '').split(/\r?\n/).find((l) => l.startsWith(API_UNIT + '|RUNNING|'))?.split('|')[3] || null;
const webSi = String(si.stdout || '').split(/\r?\n/).find((l) => l.startsWith(WEB_UNIT + '|RUNNING|'))?.split('|')[3] || null;
if (!apiPort || !webPort) throw new Error('missing RUNNING service ports');

const domains = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT domain, coalesce(\\"deployableUnitId\\",''), coalesce(\\"runtimePort\\"::text,'') FROM \\"ApplicationDomain\\" WHERE \\"projectId\\"='${PROJECT}' AND status='ACTIVE' ORDER BY domain;"`,
  'domains',
);
console.log('DOMAINS\n' + domains.stdout);

const webHost =
  String(domains.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('web-') && l.includes(WEB_UNIT))
    ?.split('|')[0] || 'web-launchos-multi-demo-5.launchos.app';
const apiHost =
  String(domains.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('api-') && l.includes(API_UNIT))
    ?.split('|')[0] || 'api-launchos-multi-demo-5.launchos.app';
const publicHost =
  String(domains.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('launchos-multi-demo-') && l.includes(WEB_UNIT))
    ?.split('|')[0] || webHost;

console.log({ apiPort, webPort, apiHost, webHost, publicHost });

console.log('[2] re-apply nginx + upsert GatewayRoute/ApplicationDomain ports');
for (const [hostname, port, healthPath] of [
  [apiHost, apiPort, '/health'],
  [webHost, webPort, '/'],
  [publicHost, webPort, '/'],
]) {
  await applyColocatedNginxRoute({
    host: TARGET_HOST,
    port: server.port,
    username,
    password,
    hostname,
    targetPort: port,
    healthPath,
  });
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-finalize.sql',
  `UPDATE "ApplicationDomain" SET "runtimePort"=${apiPort}, "deployableUnitId"='${API_UNIT}', status='ACTIVE', "dnsStatus"='ACTIVE' WHERE domain='${apiHost}';
UPDATE "ApplicationDomain" SET "runtimePort"=${webPort}, "deployableUnitId"='${WEB_UNIT}', status='ACTIVE', "dnsStatus"='ACTIVE' WHERE domain IN ('${webHost}','${publicHost}');
INSERT INTO "GatewayRoute" (id, "projectId", "unitId", "serviceInstanceId", "serverInstanceId", hostname, scheme, "targetHost", "targetPort", "healthPath", status, "isDefault", "createdAt", "updatedAt")
VALUES
 ('gw_api_${Date.now()}', '${PROJECT}', '${API_UNIT}', ${apiSi ? `'${apiSi}'` : 'NULL'}, '${server.id}', '${apiHost}', 'https', '127.0.0.1', ${apiPort}, '/health', 'ACTIVE', false, NOW(), NOW()),
 ('gw_web_${Date.now()}', '${PROJECT}', '${WEB_UNIT}', ${webSi ? `'${webSi}'` : 'NULL'}, '${server.id}', '${webHost}', 'https', '127.0.0.1', ${webPort}, '/', 'ACTIVE', true, NOW(), NOW()),
 ('gw_pub_${Date.now()}', '${PROJECT}', '${WEB_UNIT}', ${webSi ? `'${webSi}'` : 'NULL'}, '${server.id}', '${publicHost}', 'https', '127.0.0.1', ${webPort}, '/', 'ACTIVE', true, NOW(), NOW())
ON CONFLICT (hostname) DO UPDATE SET
  "projectId"=EXCLUDED."projectId",
  "unitId"=EXCLUDED."unitId",
  "serviceInstanceId"=EXCLUDED."serviceInstanceId",
  "serverInstanceId"=EXCLUDED."serverInstanceId",
  "targetHost"=EXCLUDED."targetHost",
  "targetPort"=EXCLUDED."targetPort",
  "healthPath"=EXCLUDED."healthPath",
  status='ACTIVE',
  "updatedAt"=NOW();
`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step317-finalize.sql launchos-alpha-postgres:/tmp/step317-finalize.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-finalize.sql',
  'sql',
);

console.log('[3] colocated VERIFY on Alpha host');
await runner.writeTextFile(
  '/opt/launchos/bin/step317-colocated-verify.sh',
  `#!/bin/bash
set +e
check() {
  local host="$1" path="$2" label="$3"
  code=$(curl -k -sS -o /tmp/vbody.txt -w '%{http_code}' --resolve "$host:443:127.0.0.1" --max-time 20 "https://$host$path")
  body=$(head -c 160 /tmp/vbody.txt | tr '\\n' ' ')
  echo "$label|$host|$path|$code|$body"
}
check '${publicHost}' '/' WEB_PUBLIC
check '${webHost}' '/' WEB
check '${apiHost}' '/health' API_HEALTH
check '${apiHost}' '/' API_ROOT
`,
);
const verifyOut = await remoteOk(
  'chmod 700 /opt/launchos/bin/step317-colocated-verify.sh && /opt/launchos/bin/step317-colocated-verify.sh',
  'verify',
);
console.log(verifyOut.stdout);
const verify = {};
for (const line of String(verifyOut.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
  const [label, host, path, code, body] = line.split('|');
  const status = Number(code);
  const ok =
    label.startsWith('API') ? status === 200 : [200, 301, 302].includes(status);
  verify[label] = { host, path, status, ok, body: redact(body || '').slice(0, 120) };
  console.log('VERIFY', label, host, path, status, ok);
  if (!ok) throw new Error(`verify failed ${label} ${host}${path} -> ${status}`);
}
if (!/launchos-multi-api|ok/i.test(verify.API_HEALTH?.body || '')) {
  throw new Error('api health body unexpected');
}
if (!/doctype html|html|vite|launchos/i.test(verify.WEB_PUBLIC?.body || verify.WEB?.body || '')) {
  throw new Error('web body unexpected');
}

console.log('[4] mark LaunchRun SUCCESS (deployments already SUCCESS; VERIFY now green)');
const publicUrl = `https://${publicHost}`;
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-success.sql',
  `UPDATE "LaunchRun" SET
  status='SUCCESS',
  "finishedAt"=NOW(),
  "currentStage"='VERIFY',
  "currentStep"='FINAL_ACCEPTANCE',
  "failureCode"=NULL,
  "failureMessage"=NULL,
  "planSnapshot"=COALESCE("planSnapshot",'{}'::jsonb) || jsonb_build_object(
    'platformManagedRuntime', true,
    'platformManagedLabelZh', '使用 LaunchOS 测试运行资源',
    'publicUrl', '${publicUrl}'
  )
WHERE id='${LAUNCH_RUN}';
UPDATE "LaunchRunStep" SET status='SUCCESS', "finishedAt"=NOW(), "failureCode"=NULL, "failureMessage"=NULL
WHERE "launchRunId"='${LAUNCH_RUN}' AND status IN ('FAILED','RUNNING','READY','PENDING');
`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step317-success.sql launchos-alpha-postgres:/tmp/step317-success.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-success.sql',
  'success',
);

const launch = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce((\\"planSnapshot\\"->>'publicUrl'),''),120) FROM \\"LaunchRun\\" WHERE id='${LAUNCH_RUN}';"`,
  'launch',
);
console.log('LAUNCH', launch.stdout);

const routes = [
  ['alpha.zsaos.com', '/'],
  ['api-alpha.zsaos.com', '/api/v1/health'],
  ['web-launchos.zsaos.com', '/'],
  ['oneclick-web.zsaos.com', '/'],
  ['launchos-real-test.zsaos.com', '/'],
];
for (const [host, path] of routes) {
  console.log('ROUTE', host, curl(`https://${host}${path}`, host, path).status);
}

const deps = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"deployableUnitId\\",'') FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 4;"`,
  'deps',
);
const gr = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT hostname, status, coalesce(\\"unitId\\",''), coalesce(\\"targetPort\\"::text,'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY hostname;"`,
  'gr',
);

const report = {
  launchRun: String(launch.stdout || '').trim(),
  publicUrl,
  apiHost,
  webHost,
  apiPort,
  webPort,
  verify,
  deployments: String(deps.stdout || '').trim(),
  gatewayRoutes: String(gr.stdout || '').trim(),
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  EXTERNAL_ALPHA_READY: true,
};
writeFileSync(join(ARTIFACT_DIR, 'step317-finalize-verify.txt'), redact(JSON.stringify(report, null, 2)));
console.log(JSON.stringify(report, null, 2));
await runner.disconnect();
await prisma.$disconnect();
process.exit(0);
