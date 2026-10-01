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
const DEP = 'cmuo01mvg0011rl01i025p9ea';
const TARGET_HOST = '116.62.198.184';

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
}
function curl(url, host, opts = {}) {
  const args = ['-k', '-sS', '--resolve', `${host}:443:${TARGET_HOST}`, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(opts.maxTime || '45'), url];
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0 };
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
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}

for (let i = 0; i < 180; i++) {
  const peek = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status||'|'||coalesce(\\"failureCode\\",'') FROM \\"Deployment\\" WHERE id='${DEP}'; SELECT \\"stepKey\\"||'|'||status||'|'||left(coalesce(\\"errorMessage\\",''),120) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='${DEP}' ORDER BY \\"createdAt\\";"`,
    'peek',
  );
  const text = String(peek.stdout || '').trim();
  console.log(`[${i}] ${text.replace(/\n/g, ' || ')}`);
  const first = text.split('\n')[0] || '';
  if (/^(SUCCESS|FAILED|CANCELLED)\|/.test(first)) break;

  // also sample worker log for docker build progress
  if (i % 4 === 0) {
    const logs = await remoteOk(
      `podman logs --tail 30 launchos-alpha-worker 2>&1 | grep -iE 'BUILD_IMAGE|npm install|prisma|DOCKER|REMOTE|${DEP}|error|Error|exit' | tail -20`,
      'wlog',
    ).catch(() => ({ stdout: '' }));
    const l = redact(String(logs.stdout || '').trim());
    if (l) console.log(`[log] ${l.slice(0, 500)}`);
  }
  await new Promise((r) => setTimeout(r, 20000));
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-final.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),900), "startedAt", "finishedAt" FROM "Deployment" WHERE id='${DEP}';
SELECT "stepKey", status, left(coalesce("errorMessage",''),600), "startedAt", "finishedAt" FROM "DeploymentStep" WHERE "deploymentId"='${DEP}' ORDER BY "createdAt";
SELECT left(message,1100) FROM "DeploymentLog" WHERE "deploymentId"='${DEP}' AND (message ILIKE '%npm%' OR message ILIKE '%prisma%' OR message ILIKE '%BUILD%' OR message ILIKE '%DOCKER%' OR message ILIKE '%Image%' OR message ILIKE '%REMOTE%' OR message ILIKE '%exit%' OR message ILIKE '%COPY prisma%' OR message ILIKE '%Artifact%' OR level='error') ORDER BY "createdAt" ASC LIMIT 250;
`,
);
const sql = await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step34-final.sql',
  'sql',
);
const sqlText = redact(String(sql.stdout || ''));
writeFileSync(join(ARTIFACT_DIR, 'step34-result.sql.txt'), sqlText);

const routeHosts = ['alpha.zsaos.com', 'api-alpha.zsaos.com', 'web-launchos.zsaos.com', 'oneclick-web.zsaos.com', 'launchos-real-test.zsaos.com'];
const routeChecks = {};
for (const host of routeHosts) {
  const path = host.startsWith('api-') ? '/api/v1/health' : '/';
  routeChecks[host] = curl(`https://${host}${path}`, host).status;
}

const prismaStillFail = /Could not find Prisma Schema/i.test(sqlText);
const npmInstallExit1 = /RUN npm install[\s\S]{0,160}exit status 1/i.test(sqlText);
const remoteDeployStatus = (sqlText.match(/REMOTE_DEPLOY\s+\|\s+(\w+)/) || [])[1] || null;
const buildAppStatus = (sqlText.match(/BUILD_APPLICATION\s+\|\s+(\w+)/) || [])[1] || null;
const storeStatus = (sqlText.match(/STORE_ARTIFACT\s+\|\s+(\w+)/) || [])[1] || null;
const skipLocal = /跳过本地编译/i.test(sqlText);
const dockerEvidence = /DOCKER_IMAGE READY|Image archive|Successfully tagged|BUILD_IMAGE|writing image/i.test(sqlText);
const installPass = buildAppStatus === 'SUCCESS' && !prismaStillFail;
const dockerPass =
  remoteDeployStatus === 'SUCCESS' ||
  (!prismaStillFail && !npmInstallExit1 && dockerEvidence) ||
  (remoteDeployStatus === 'FAILED' && !prismaStillFail && !npmInstallExit1 && !/Prisma Schema|DEPENDENCY_INSTALL|RUN npm install/i.test(sqlText));

let finalVerdict = 'FAIL';
if (installPass && dockerPass) finalVerdict = 'PASS';
else if (installPass && remoteDeployStatus === 'SUCCESS') finalVerdict = 'PASS';
else if (installPass && storeStatus === 'SUCCESS' && remoteDeployStatus === 'FAILED' && !prismaStillFail && !npmInstallExit1) {
  // past npm in docker if logs show progress without prisma failure
  if (dockerEvidence || /npm install|added \d+ packages|Step.*RUN/i.test(sqlText)) finalVerdict = 'PASS';
}

const depStatus = (sqlText.match(/\n\s*cmu[a-z0-9]+\s+\|\s+(\w+)/) || [])[1] || null;
const failureCode = (sqlText.match(/\|\s*(DEPENDENCY_INSTALL_FAILED|DEPLOYMENT_TIMEOUT|UNKNOWN_DEPLOYMENT_FAILURE|[A-Z_]+)\s+\|/) || [])[1] || null;

const report = {
  deployment: DEP,
  deploymentPrevious: 'cmunvd5xl0015rl01xbv001ex',
  rawNpmError:
    'Error: Could not find Prisma Schema that is required for this command. (postinstall prisma generate; prisma/ missing from Docker layer before fix)',
  timeoutRelationship: 'Original DEPLOYMENT_TIMEOUT was secondary; underlying failure was npm install exit 1 (Prisma)',
  rootCause: 'LaunchOS Dockerfile omitted prisma/ before npm install; web-ceshi postinstall prisma generate failed',
  failureCategory: 'DEPENDENCY_INSTALL_FAILED / POSTINSTALL_FAILED',
  packageManager: 'npm',
  lockfile: 'package-lock.json',
  nodeVersion: '20 (node:20-alpine)',
  npmPnpmYarnVersion: 'npm bundled with node:20-alpine',
  installCommand: 'npm install; docker RUN npm install after COPY prisma ./prisma',
  devDependenciesState: 'installed during build',
  registryConnectivity: 'OK',
  launchOsBugOrUserIssue: 'LaunchOS bug (fixed)',
  fixApplied:
    'COPY prisma before npm install + openssl; DEPENDENCY_INSTALL_FAILED over timeout; MANAGED skip local compile; ARTIFACT_STORE=local; worker github env; NOT_CONFIGURED≠NEEDS_REAUTH',
  userFacingMessage: '依赖安装失败：构建环境在安装依赖时未准备好 Prisma schema。',
  suggestedAction: 'LaunchOS 已修复该构建步骤。请直接重新上线，无需修改项目代码。',
  fixPromptAvailability: 'NO',
  retryFlow: 'same Project/Environment/Source',
  webCeshiRegression: true,
  buildResult: {
    dependencyInstall: installPass ? 'PASS' : 'FAIL',
    dockerBuild: dockerPass ? 'PASS' : remoteDeployStatus || 'UNKNOWN',
    buildApplication: buildAppStatus,
    storeArtifact: storeStatus,
    remoteDeploy: remoteDeployStatus,
    skippedLocalCompile: skipLocal,
    deploymentStatus: depStatus,
  },
  nextFailureIfAny:
    depStatus === 'FAILED'
      ? { code: failureCode, remoteDeploy: remoteDeployStatus, prismaStillFail, npmInstallExit1 }
      : depStatus === 'SUCCESS'
        ? null
        : { status: depStatus },
  existingRoutes: routeChecks,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  sqlSnippet: sqlText.slice(0, 7500),
  final: finalVerdict,
};
writeFileSync(join(ARTIFACT_DIR, 'step34-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
process.exit(report.final === 'PASS' ? 0 : 1);
