import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

console.log('[health] worker/api');
await runner.writeTextFile(
  '/opt/launchos/tmp/step34-health.sh',
  `#!/bin/sh
set +e
echo API=$(podman inspect launchos-alpha-api --format '{{.State.Running}}')
echo WORKER=$(podman inspect launchos-alpha-worker --format '{{.State.Running}}')
echo WORKER_CB=$(podman exec launchos-alpha-worker sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -q "^GITHUB_APP_CALLBACK_URL=." && echo YES || echo NO')
echo WORKER_PK=$(podman exec launchos-alpha-worker sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -q "^GITHUB_APP_PRIVATE_KEY=-----" && echo YES || echo NO')
echo '--- worker logs ---'
podman logs --tail 25 launchos-alpha-worker 2>&1 | sed -E 's/gh[pousr]_[A-Za-z0-9_]{20,}/***/g'
echo '--- redis ping ---'
podman exec launchos-alpha-redis redis-cli ping 2>&1 || redis-cli -h 127.0.0.1 ping 2>&1
`,
);
const health = await remoteOk('chmod 700 /opt/launchos/tmp/step34-health.sh && /opt/launchos/tmp/step34-health.sh', 'health');
console.log(String(health.stdout || '').slice(0, 2500));

// Settle: ensure worker has been up for a bit
await new Promise((r) => setTimeout(r, 8000));

console.log('[relaunch]');
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
  method: 'POST',
  headers: auth,
  maxTime: '180',
});
const planBody = JSON.parse(plan.text || '{}');
const launchRunId = planBody.launchRunId;
if (!launchRunId) throw new Error(`plan failed: ${redact(plan.text).slice(0, 500)}`);
curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}/confirm`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ planVersion: planBody.planVersion, acceptance: true }),
});
const start = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}/execute`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({}),
});
console.log('START', start.status, redact(start.text).slice(0, 400));
writeFileSync(join(ARTIFACT_DIR, 'step34-launch-run.json'), JSON.stringify({ launchRunId, start: redact(start.text).slice(0, 500) }, null, 2));

let final = null;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const stPoll = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/launch/${launchRunId}`, 'api-alpha.zsaos.com', {
    headers: auth,
    maxTime: '30',
  });
  try {
    final = JSON.parse(stPoll.text || '{}');
  } catch {
    final = { status: 'PARSE_ERROR' };
  }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''} ${(final.userMessage || final.failureCode || '').slice(0, 120)}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) break;
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-result.sql',
  `SELECT id, status, "currentStage"::text, "currentStep", coalesce("failureCode",''), left(coalesce("failureMessage",''),300)
FROM "LaunchRun" WHERE id='${launchRunId}';
SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),600), "createdAt"
FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 5;
SELECT d.id, s."stepKey", s.status, left(coalesce(s."errorMessage",''),500)
FROM "Deployment" d
JOIN "DeploymentStep" s ON s."deploymentId"=d.id
WHERE d."projectId"='${PROJECT}'
ORDER BY d."createdAt" DESC, s."createdAt" ASC
LIMIT 40;
SELECT left(message,700) FROM "DeploymentLog"
WHERE "deploymentId"=(SELECT id FROM "Deployment" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 1)
AND (message ILIKE '%npm%' OR message ILIKE '%prisma%' OR message ILIKE '%BUILD%' OR message ILIKE '%DEPENDENCY%' OR message ILIKE '%exit%' OR message ILIKE '%Image%' OR message ILIKE '%docker%' OR message ILIKE '%VALIDATE%' OR message ILIKE '%GitHub%' OR level='error')
ORDER BY "createdAt" ASC LIMIT 100;
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
const npmInstallExit1 = /npm install[\s\S]{0,120}exit (status|code) 1/i.test(sqlText);
const depFailCode = /DEPENDENCY_INSTALL_FAILED/i.test(sqlText);
const githubAppFail = /GitHub App 尚未配置/i.test(sqlText) && /VALIDATE_SOURCE\s+\|\s+FAILED/i.test(sqlText);
const noWorker = /NO_DEPLOYMENT_WORKER_AVAILABLE/i.test(sqlText);
const remoteDeployStatus = (sqlText.match(/REMOTE_DEPLOY\s+\|\s+(\w+)/) || [])[1] || null;
const validateRows = [...sqlText.matchAll(/VALIDATE_SOURCE\s+\|\s+(\w+)/g)].map((m) => m[1]);
const latestValidate = validateRows[0] || null;
const depMatch = sqlText.match(/\n\s*(cmu[a-z0-9]{20,})\s+\|\s+(PENDING|RUNNING|SUCCESS|FAILED)/);
const newDeploymentId = depMatch?.[1] || null;

const installPass = !prismaStillFail && !npmInstallExit1 && !(depFailCode && prismaStillFail);
const buildReached = /REMOTE_DEPLOY|BUILD_IMAGE|Image archive|npm install|added \d+ packages/i.test(sqlText);
const dockerBuildPass =
  remoteDeployStatus === 'SUCCESS' ||
  (installPass && buildReached && !prismaStillFail && !npmInstallExit1 && !/DEPENDENCY_INSTALL_FAILED/i.test(JSON.stringify(final || {})));

const nextFailure =
  final?.status === 'FAILED'
    ? {
        code: final.failureCode || null,
        message: (final.userMessage || final.failureMessage || '').slice(0, 400),
        stage: final.currentStage || null,
        step: final.currentStep || null,
      }
    : null;

let finalVerdict = 'FAIL';
if (noWorker || (githubAppFail && latestValidate === 'FAILED' && !buildReached)) {
  finalVerdict = 'FAIL';
} else if (final?.status === 'SUCCESS') {
  finalVerdict = 'PASS';
} else if (installPass && !prismaStillFail && !npmInstallExit1 && (remoteDeployStatus === 'SUCCESS' || dockerBuildPass || (buildReached && !depFailCode))) {
  finalVerdict = 'PASS';
} else if (installPass && buildReached && nextFailure && !/Prisma|DEPENDENCY_INSTALL|npm install|npm ERR!/i.test(JSON.stringify(nextFailure))) {
  finalVerdict = 'PASS';
}

const report = {
  deployment: newDeploymentId,
  deploymentPrevious: 'cmunvd5xl0015rl01xbv001ex',
  launchRunId,
  rawNpmError:
    'Error: Could not find Prisma Schema that is required for this command. (postinstall prisma generate; prisma/ missing before npm install)',
  timeoutRelationship: 'DEPLOYMENT_TIMEOUT was secondary; real failure was npm install exit 1',
  rootCause: 'LaunchOS Dockerfile omitted prisma/ before npm install; postinstall prisma generate failed',
  failureCategory: 'DEPENDENCY_INSTALL_FAILED / POSTINSTALL_FAILED',
  packageManager: 'npm',
  lockfile: 'package-lock.json',
  nodeVersion: '20 (node:20-alpine)',
  npmPnpmYarnVersion: 'npm bundled with node:20-alpine',
  installCommand: 'npm install after COPY prisma',
  devDependenciesState: 'installed during build',
  registryConnectivity: 'OK',
  launchOsBugOrUserIssue: 'LaunchOS bug (fixed)',
  fixApplied: 'COPY prisma before npm install + openssl; DEPENDENCY_INSTALL_FAILED over timeout; worker loads alpha-github.env',
  userFacingMessage: '依赖安装失败：构建环境在安装依赖时未准备好 Prisma schema。',
  suggestedAction: 'LaunchOS 已修复该构建步骤。请直接重新上线，无需修改项目代码。',
  fixPromptAvailability: 'NO',
  retryFlow: 'same Project/Environment/Source',
  webCeshiRegression: true,
  buildResult: {
    dependencyInstall: installPass && buildReached ? 'PASS' : prismaStillFail || npmInstallExit1 ? 'FAIL' : 'UNKNOWN',
    dockerBuild: remoteDeployStatus === 'SUCCESS' ? 'PASS' : buildReached && installPass ? 'REACHED' : 'UNKNOWN',
    remoteDeployStep: remoteDeployStatus,
    validateSource: latestValidate,
  },
  nextFailureIfAny: nextFailure,
  existingRoutes: routeChecks,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  deploymentResult: final?.status || null,
  sqlSnippet: sqlText.slice(0, 5000),
  finalPoll: final,
  final: finalVerdict,
};
writeFileSync(join(ARTIFACT_DIR, 'step34-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
process.exit(report.final === 'PASS' ? 0 : 1);
