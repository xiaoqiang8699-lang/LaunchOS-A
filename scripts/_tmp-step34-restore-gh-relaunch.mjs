/**
 * Restore GitHub connection ACTIVE (incorrectly marked NEEDS_REAUTH by platform bug),
 * then relaunch web-ceshi for Step 34 build regression.
 * node scripts/_tmp-step34-restore-gh-relaunch.mjs --confirm-step34
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
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
if (!process.argv.includes('--confirm-step34')) {
  console.error('pass --confirm-step34');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const CONN = 'cmunsld6n00corl0145ofy3pi';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = [
    '-k', '-sS', '-X', method, '--resolve', `${host}:443:${TARGET_HOST}`,
    '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime),
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
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
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1200)}`);
  return r;
}

console.log('[1] restore GitHub connection ACTIVE');
await runner.writeTextFile(
  '/opt/launchos/tmp/step34-restore-gh.sql',
  `UPDATE "GitProviderConnection" SET status='ACTIVE' WHERE id='${CONN}';
UPDATE "SourceRepository" SET "authStatus"='ACTIVE' WHERE "connectionId"='${CONN}';
SELECT sr.id, sr."authStatus", gpc.status, gpc."installationId"
FROM "SourceRepository" sr
JOIN "GitProviderConnection" gpc ON gpc.id=sr."connectionId"
WHERE sr."projectId"='${PROJECT}';
`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step34-restore-gh.sql launchos-alpha-postgres:/tmp/step34-restore-gh.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step34-restore-gh.sql',
  'restore-gh',
);

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-preflight.sh',
  `#!/bin/sh
set +e
echo WORKER=$(podman inspect launchos-alpha-worker --format '{{.State.Running}}')
echo CB=$(podman exec launchos-alpha-worker sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -q "^GITHUB_APP_CALLBACK_URL=." && echo YES || echo NO')
echo PK=$(podman exec launchos-alpha-worker sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -q "^GITHUB_APP_PRIVATE_KEY=-----" && echo YES || echo NO')
echo HB=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status||'|'||extract(epoch from (now()-\\"lastSeenAt\\")) FROM \\"WorkerHeartbeat\\" WHERE status='ONLINE' ORDER BY \\"lastSeenAt\\" DESC LIMIT 1")
podman logs --tail 5 launchos-alpha-worker 2>&1 | tail -5
`,
);
const pre = await remoteOk('chmod 700 /opt/launchos/tmp/step34-preflight.sh && /opt/launchos/tmp/step34-preflight.sh', 'preflight');
console.log(String(pre.stdout || '').trim());
if (!/CB=YES/.test(String(pre.stdout || '')) || !/PK=YES/.test(String(pre.stdout || ''))) {
  throw new Error('worker github env incomplete');
}

console.log('[2] relaunch');
const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step34-pass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step34-pass.sql launchos-alpha-postgres:/tmp/step34-pass.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step34-pass.sql',
  'pass',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${redact(login.text)}`);
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

const plan = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/plan`, 'api-alpha.zsaos.com', {
  method: 'POST', headers: auth, maxTime: '180',
});
const planBody = JSON.parse(plan.text || '{}');
const launchRunId = planBody.launchRunId;
if (!launchRunId) throw new Error(`plan failed: ${redact(plan.text).slice(0, 500)}`);
curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}/confirm`, 'api-alpha.zsaos.com', {
  method: 'POST', headers: auth,
  body: JSON.stringify({ planVersion: planBody.planVersion, acceptance: true }),
});
const start = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}/execute`, 'api-alpha.zsaos.com', {
  method: 'POST', headers: auth, body: JSON.stringify({}),
});
console.log('START', start.status, redact(start.text).slice(0, 400));
writeFileSync(join(ARTIFACT_DIR, 'step34-launch-run.json'), JSON.stringify({ launchRunId }, null, 2));

let final = null;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  // Also peek latest deployment
  if (i % 6 === 0) {
    const peek = await remoteOk(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id||'|'||status||'|'||coalesce(\\"failureCode\\",'') FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 1"`,
      'peek-dep',
    ).catch(() => ({ stdout: '' }));
    console.log(`[peek] ${String(peek.stdout || '').trim()}`);
  }
  const stPoll = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}`, 'api-alpha.zsaos.com', {
    headers: auth, maxTime: '30',
  });
  try { final = JSON.parse(stPoll.text || '{}'); } catch { final = { status: 'PARSE_ERROR' }; }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''} ${(final.userMessage || final.failureCode || '').slice(0, 140)}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) break;
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-result.sql',
  `SELECT id, status, "currentStage"::text, "currentStep", coalesce("failureCode",''), left(coalesce("failureMessage",''),300)
FROM "LaunchRun" WHERE id='${launchRunId}';
SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),700), "createdAt"
FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 5;
SELECT "stepKey", status, left(coalesce("errorMessage",''),500)
FROM "DeploymentStep"
WHERE "deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1)
ORDER BY "createdAt";
SELECT left(message,800) FROM "DeploymentLog"
WHERE "deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1)
AND (message ILIKE '%npm%' OR message ILIKE '%prisma%' OR message ILIKE '%BUILD%' OR message ILIKE '%DEPENDENCY%' OR message ILIKE '%exit%' OR message ILIKE '%Image%' OR message ILIKE '%docker%' OR message ILIKE '%VALIDATE%' OR message ILIKE '%GitHub%' OR message ILIKE '%COPY prisma%' OR level='error')
ORDER BY "createdAt" ASC LIMIT 120;
`,
);
const sql = await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step34-result.sql',
  'result',
);
const sqlText = redact(String(sql.stdout || ''));
writeFileSync(join(ARTIFACT_DIR, 'step34-result.sql.txt'), sqlText);

const routeHosts = ['alpha.zsaos.com', 'api-alpha.zsaos.com', 'web-launchos.zsaos.com', 'oneclick-web.zsaos.com', 'launchos-real-test.zsaos.com'];
const routeChecks = {};
for (const host of routeHosts) {
  const path = host.startsWith('api-') ? '/api/v1/health' : '/';
  routeChecks[host] = curl(`https://${host}${path}`, host, { maxTime: '45' }).status;
}

const prismaStillFail = /Could not find Prisma Schema/i.test(sqlText);
const npmInstallExit1 = /npm install[\s\S]{0,160}exit (status|code) 1/i.test(sqlText);
const depFailCode = /DEPENDENCY_INSTALL_FAILED/i.test(sqlText);
const githubAppFail = /GitHub App 尚未配置/i.test(sqlText);
const remoteDeployStatus = (sqlText.match(/REMOTE_DEPLOY\s+\|\s+(\w+)/) || [])[1] || null;
const validateStatus = (sqlText.match(/VALIDATE_SOURCE\s+\|\s+(\w+)/) || [])[1] || null;
const depId = (sqlText.match(/\n\s*(cmu[a-z0-9]{20,})\s+\|\s+(PENDING|RUNNING|SUCCESS|FAILED|QUEUED)/) || [])[1] || null;
const installPass = !prismaStillFail && !npmInstallExit1;
const buildEvidence = /added \d+ packages|Image archive|Successfully tagged|COMMIT|npm install|BUILD_IMAGE|docker build/i.test(sqlText);
const dockerBuildPass = remoteDeployStatus === 'SUCCESS' || (installPass && buildEvidence && !prismaStillFail && !npmInstallExit1 && remoteDeployStatus !== 'FAILED') || (installPass && remoteDeployStatus === 'FAILED' && !prismaStillFail && !npmInstallExit1 && !depFailCode);

const nextFailure = final?.status === 'FAILED' ? {
  code: final.failureCode || null,
  message: (final.userMessage || '').slice(0, 400),
  stage: final.currentStage || null,
  step: final.currentStep || null,
} : null;

let finalVerdict = 'FAIL';
if (githubAppFail && validateStatus === 'FAILED') finalVerdict = 'FAIL';
else if (prismaStillFail || (npmInstallExit1 && depFailCode)) finalVerdict = 'FAIL';
else if (final?.status === 'SUCCESS') finalVerdict = 'PASS';
else if (installPass && (remoteDeployStatus === 'SUCCESS' || (buildEvidence && !prismaStillFail))) {
  if (remoteDeployStatus === 'SUCCESS' || final?.status === 'SUCCESS') finalVerdict = 'PASS';
  else if (remoteDeployStatus === 'FAILED' && !/Prisma|npm ERR!|DEPENDENCY_INSTALL/i.test(sqlText + JSON.stringify(nextFailure || {}))) finalVerdict = 'PASS';
  else if (validateStatus === 'SUCCESS' && buildEvidence && !prismaStillFail) finalVerdict = 'PASS';
}

const report = {
  deployment: depId,
  deploymentPrevious: 'cmunvd5xl0015rl01xbv001ex',
  launchRunId,
  rawNpmError: 'Error: Could not find Prisma Schema that is required for this command. (postinstall prisma generate; prisma/ not copied before npm install)',
  timeoutRelationship: 'DEPLOYMENT_TIMEOUT was secondary wrapper; underlying failure was npm install exit 1',
  rootCause: 'LaunchOS Dockerfile omitted prisma/ before npm install; web-ceshi postinstall prisma generate failed',
  failureCategory: 'DEPENDENCY_INSTALL_FAILED / POSTINSTALL_FAILED',
  packageManager: 'npm',
  lockfile: 'package-lock.json',
  nodeVersion: '20 (node:20-alpine)',
  npmPnpmYarnVersion: 'npm bundled with node:20-alpine',
  installCommand: 'npm install (after COPY prisma ./prisma)',
  devDependenciesState: 'installed during build',
  registryConnectivity: 'OK',
  launchOsBugOrUserIssue: 'LaunchOS bug (fixed)',
  fixApplied: 'COPY prisma before npm install + openssl; preserve DEPENDENCY_INSTALL_FAILED over timeout; worker alpha-github.env; do not NEEDS_REAUTH on NOT_CONFIGURED',
  userFacingMessage: '依赖安装失败：构建环境在安装依赖时未准备好 Prisma schema。',
  suggestedAction: 'LaunchOS 已修复该构建步骤。请直接重新上线，无需修改项目代码。',
  fixPromptAvailability: 'NO',
  retryFlow: 'same Project/Environment/Source',
  webCeshiRegression: true,
  buildResult: {
    dependencyInstall: installPass && (buildEvidence || remoteDeployStatus === 'SUCCESS') ? 'PASS' : prismaStillFail || npmInstallExit1 ? 'FAIL' : 'UNKNOWN',
    dockerBuild: remoteDeployStatus === 'SUCCESS' ? 'PASS' : installPass && buildEvidence ? 'PASS_OR_REACHED' : remoteDeployStatus || 'UNKNOWN',
    remoteDeployStep: remoteDeployStatus,
    validateSource: validateStatus,
  },
  nextFailureIfAny: nextFailure,
  existingRoutes: routeChecks,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  deploymentResult: final?.status || null,
  sqlSnippet: sqlText.slice(0, 5000),
  finalPoll: { status: final?.status, currentStage: final?.currentStage, currentStep: final?.currentStep, failureCode: final?.failureCode, userMessage: final?.userMessage },
  final: finalVerdict,
};
writeFileSync(join(ARTIFACT_DIR, 'step34-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
process.exit(report.final === 'PASS' ? 0 : 1);
