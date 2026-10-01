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
const TARGET_HOST = '116.62.198.184';

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken|AUTH_SECRET)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
}
function curl(url, host, opts = {}) {
  const args = [
    '-k', '-sS', '-L', '--resolve', `${host}:443:${TARGET_HOST}`,
    '-w', '\n__CODE__:%{http_code}\n__SSL__:%{ssl_verify_result}\n__TIME__:%{time_total}',
    '--max-time', String(opts.maxTime || '45'),
    '-A', 'LaunchOS-Step35-Probe/1.0',
    url,
  ];
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
  const out = String(r.stdout || '');
  const code = Number((out.match(/__CODE__:(\d+)/) || [])[1] || 0);
  const ssl = (out.match(/__SSL__:(\d+)/) || [])[1] || null;
  const time = (out.match(/__TIME__:([0-9.]+)/) || [])[1] || null;
  const body = out.replace(/\n__CODE__:[\s\S]*$/, '');
  return {
    code,
    ssl,
    time,
    bodyFingerprint: body.replace(/\s+/g, ' ').slice(0, 180),
    stderr: String(r.stderr || '').slice(0, 300),
  };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 2000)}`);
  return r;
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step35-locate.sql',
  `SELECT p.id AS project_id, p.name, p.slug, u.email
FROM "Project" p
JOIN "Workspace" w ON w.id=p."workspaceId"
JOIN "User" u ON u.id=w."ownerId"
WHERE u.email='1002@qq.com'
ORDER BY CASE WHEN p.name ILIKE '%web-ceshi%' OR p.slug ILIKE '%web-ceshi%' OR p.name ILIKE '%ceshi%' THEN 0 ELSE 1 END, p."createdAt" DESC;

\\set project_id 'cmunsm2lk00ctrl01nnu1pwyd'

SELECT id, status, "currentStage"::text, "currentStep",
  coalesce("failureCode",'') AS failure_code,
  left(coalesce("failureMessage",''),220) AS failure_message,
  "updatedAt", "createdAt", "startedAt", "finishedAt"
FROM "LaunchRun"
WHERE "projectId"='cmunsm2lk00ctrl01nnu1pwyd'
ORDER BY "createdAt" DESC LIMIT 10;

SELECT id, status, coalesce("failureCode",'') AS failure_code,
  left(coalesce("errorMessage",''),260) AS error_message,
  "currentStage", "lastActivityAt", "updatedAt", "createdAt", "finishedAt",
  "deployableUnitId", "bullmqJobId", "queueStallCount"
FROM "Deployment"
WHERE "projectId"='cmunsm2lk00ctrl01nnu1pwyd'
ORDER BY "createdAt" DESC LIMIT 10;

SELECT id, status, "healthStatus", port, "internalPort", "externalPort",
  left(coalesce("containerId",''),64) AS container_id,
  left(coalesce("imageTag",''),140) AS image_tag,
  "lastHealthCheckAt", left(coalesce("healthMessage",''),160) AS health_message,
  "updatedAt", "createdAt", "deployableUnitId"
FROM "ServiceInstance"
WHERE "projectId"='cmunsm2lk00ctrl01nnu1pwyd'
ORDER BY "createdAt" DESC LIMIT 10;

SELECT id, domain, status, "dnsStatus", "sslStatus", "runtimeHost", "runtimePort", "deployableUnitId", "updatedAt"
FROM "ApplicationDomain"
WHERE "projectId"='cmunsm2lk00ctrl01nnu1pwyd'
ORDER BY "updatedAt" DESC LIMIT 10;

SELECT id, hostname, status, "healthPath", "targetHost", "targetPort", "serviceInstanceId", "unitId", "updatedAt"
FROM "GatewayRoute"
WHERE "projectId"='cmunsm2lk00ctrl01nnu1pwyd'
ORDER BY "updatedAt" DESC LIMIT 10;

-- latest deployment steps (current + previous success)
WITH latest AS (
  SELECT id FROM "Deployment" WHERE "projectId"='cmunsm2lk00ctrl01nnu1pwyd' ORDER BY "createdAt" DESC LIMIT 3
)
SELECT d.id AS deployment_id, s."stepKey", s.status,
  left(coalesce(s."errorMessage",''),200) AS error_message,
  s."startedAt", s."finishedAt", s.duration
FROM "DeploymentStep" s
JOIN latest d ON d.id=s."deploymentId"
ORDER BY d.id, s."createdAt";

SELECT "workerId", status, "lastSeenAt",
  extract(epoch from (now() - "lastSeenAt")) AS age_sec,
  left(coalesce(meta::text,''),350) AS meta
FROM "WorkerHeartbeat"
ORDER BY "lastSeenAt" DESC LIMIT 5;
`,
);

const sql = await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step35-locate.sql',
  'locate',
);
const sqlText = redact(String(sql.stdout || ''));
writeFileSync(join(ARTIFACT_DIR, 'step35-locate.sql.txt'), sqlText);
console.log(sqlText.slice(0, 14000));

// Extract domains for external probe
const domains = [...sqlText.matchAll(/\n\s*[^\s|]+\s+\|\s+([a-z0-9.-]+\.zsaos\.com)\s+\|/gi)].map((m) => m[1]);
const uniqDomains = [...new Set(domains)];
console.log('DOMAINS', uniqDomains);

const probes = {};
for (const host of uniqDomains.slice(0, 5)) {
  probes[host] = curl(`https://${host}/`, host);
  console.log('PROBE', host, probes[host].code, probes[host].bodyFingerprint.slice(0, 100));
}
writeFileSync(join(ARTIFACT_DIR, 'step35-public-probes.json'), JSON.stringify({ probes, domains: uniqDomains }, null, 2));

await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
