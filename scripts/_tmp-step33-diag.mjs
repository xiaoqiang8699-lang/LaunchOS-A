/**
 * Diagnose Step 33 launch failure after AUTH_SECRET was configured.
 * node scripts/_tmp-step33-diag.mjs
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const TARGET_HOST = '116.62.198.184';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const LR = 'cmunvd3e10007rl01xx0uzp08';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
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

await runner.writeTextFile(
  '/opt/launchos/tmp/step33-diag.sql',
  `SELECT id, status, "currentStage"::text, "currentStep", coalesce("failureCode",''), left(coalesce("failureMessage",''),240),
  "planSnapshot"->'failurePresentation'->>'category',
  "planSnapshot"->'failurePresentation'->>'techCode',
  "planSnapshot"->'failurePresentation'->>'userMessage',
  "planSnapshot"->'rawFailureDetail'
FROM "LaunchRun" WHERE id='${LR}';

SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),240), coalesce("deployableUnitId",'')
FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 5;

SELECT "stepKey", status, left(coalesce("errorMessage",''),240)
FROM "DeploymentStep"
WHERE "deploymentId" = (SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1)
ORDER BY "createdAt";

SELECT key, status::text FROM "RuntimeConfigRequirement" WHERE "projectId"='${PROJECT}' AND key='AUTH_SECRET';
SELECT key, left("valueEncrypted",12), source, "isSensitive"::text FROM "RuntimeConfigValue" WHERE "projectId"='${PROJECT}' AND key='AUTH_SECRET';
SELECT key, action::text, metadata->>'productAction', metadata->>'origin'
FROM "SecretAuditEvent" WHERE "projectId"='${PROJECT}' AND key='AUTH_SECRET' ORDER BY "createdAt" DESC LIMIT 3;

SELECT hostname, status FROM "GatewayRoute" WHERE "projectId"='${PROJECT}' ORDER BY "updatedAt" DESC LIMIT 8;
`,
);

const sql = await runner.execute(
  shellCommand(
    'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step33-diag.sql',
  ),
  { timeoutMs: 60000 },
);
const logs = await runner.execute(
  shellCommand(
    `podman logs --tail 80 launchos-alpha-api 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,})[=:][^ ]+/\\1=***/gi' | grep -E '${LR}|AUTH_SECRET|RUNTIME_CONFIG|FAILED|error|Error|DEPLOY' | tail -40`,
  ),
  { timeoutMs: 60000 },
);
const routes = ['alpha.zsaos.com', 'api-alpha.zsaos.com', 'web-launchos.zsaos.com', 'oneclick-web.zsaos.com', 'launchos-real-test.zsaos.com'];
const routeChecks = {};
for (const host of routes) {
  const path = host.startsWith('api-') ? '/api/v1/health' : '/';
  const r = spawnSync(
    'curl.exe',
    ['-k', '-sS', '-o', 'NUL', '-w', '%{http_code}', '--resolve', `${host}:443:${TARGET_HOST}`, '--max-time', '30', `https://${host}${path}`],
    { encoding: 'utf8' },
  );
  routeChecks[host] = String(r.stdout || '').trim();
}

const out = {
  sql: redact(String(sql.stdout || '')),
  sqlErr: redact(String(sql.stderr || '')).slice(0, 500),
  logs: redact(String(logs.stdout || '')).slice(0, 3000),
  routeChecks,
};
writeFileSync(join(ARTIFACT_DIR, 'step33-diag.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
await runner.disconnect();
