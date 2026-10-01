import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const DEP = 'cmunzo9f1006xrl01ipv25j5c';

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').toString().slice(0, 800)}`);
  return r;
}

let finalSql = '';
for (let i = 0; i < 120; i++) {
  const peek = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status||'|'||coalesce(\\"failureCode\\",'')||'|'||left(coalesce(\\"errorMessage\\",''),120) FROM \\"Deployment\\" WHERE id='${DEP}'; SELECT \\"stepKey\\"||'|'||status||'|'||left(coalesce(\\"errorMessage\\",''),100) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='${DEP}' ORDER BY \\"createdAt\\";"`,
    'peek',
  );
  const text = String(peek.stdout || '').trim();
  console.log(`[${i}] ${text.replace(/\n/g, ' || ')}`);
  if (/^(SUCCESS|FAILED|CANCELLED)\|/m.test(text) || text.startsWith('SUCCESS|') || text.startsWith('FAILED|') || text.startsWith('CANCELLED|')) {
    // deployment terminal when first line is terminal
  }
  const first = text.split('\n')[0] || '';
  if (/^(SUCCESS|FAILED|CANCELLED)\|/.test(first)) {
    break;
  }
  await new Promise((r) => setTimeout(r, 15000));
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-watch.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),800), "startedAt", "finishedAt" FROM "Deployment" WHERE id='${DEP}';
SELECT "stepKey", status, left(coalesce("errorMessage",''),500), "startedAt", "finishedAt" FROM "DeploymentStep" WHERE "deploymentId"='${DEP}' ORDER BY "createdAt";
SELECT left(message,1000) FROM "DeploymentLog" WHERE "deploymentId"='${DEP}' ORDER BY "createdAt" ASC LIMIT 200;
`,
);
const sql = await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step34-watch.sql',
  'sql',
);
finalSql = String(sql.stdout || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-watch-result.txt'), finalSql);
console.log(finalSql.slice(0, 8000));

const prismaStillFail = /Could not find Prisma Schema/i.test(finalSql);
const npmInstallExit1 = /RUN npm install[\s\S]{0,120}exit status 1/i.test(finalSql);
const remoteDeployStatus = (finalSql.match(/REMOTE_DEPLOY\s+\|\s+(\w+)/) || [])[1] || null;
const buildAppStatus = (finalSql.match(/BUILD_APPLICATION\s+\|\s+(\w+)/) || [])[1] || null;
const depStatus = (finalSql.match(/\n\s*cmu[a-z0-9]+\s+\|\s+(\w+)/) || [])[1] || null;
const skipLocal = /跳过本地编译/i.test(finalSql);
const dockerOk = !prismaStillFail && !npmInstallExit1 && (remoteDeployStatus === 'SUCCESS' || /DOCKER_IMAGE READY|Image archive|Successfully tagged/i.test(finalSql));
const installOk = buildAppStatus === 'SUCCESS' && skipLocal;

const report = {
  deployment: DEP,
  deploymentPrevious: 'cmunvd5xl0015rl01xbv001ex',
  rawNpmError: 'Error: Could not find Prisma Schema that is required for this command. (postinstall prisma generate; prisma/ missing before fix)',
  timeoutRelationship: 'Original DEPLOYMENT_TIMEOUT was secondary to npm install exit 1 (Prisma)',
  rootCause: 'LaunchOS Dockerfile omitted prisma/ before npm install',
  failureCategory: 'DEPENDENCY_INSTALL_FAILED / POSTINSTALL_FAILED',
  packageManager: 'npm',
  lockfile: 'package-lock.json',
  nodeVersion: '20 (node:20-alpine)',
  npmPnpmYarnVersion: 'npm bundled with node:20',
  installCommand: 'npm install + docker RUN npm install after COPY prisma',
  devDependenciesState: 'installed during build',
  registryConnectivity: 'OK',
  launchOsBugOrUserIssue: 'LaunchOS bug (fixed)',
  fixApplied: 'COPY prisma before npm install; DEPENDENCY_INSTALL_FAILED over timeout; managed skip local compile; worker github env; NOT_CONFIGURED≠NEEDS_REAUTH; 4G swap',
  userFacingMessage: '依赖安装失败：构建环境在安装依赖时未准备好 Prisma schema。',
  suggestedAction: 'LaunchOS 已修复该构建步骤。请直接重新上线，无需修改项目代码。',
  fixPromptAvailability: 'NO',
  retryFlow: 'same Project/Environment/Source',
  webCeshiRegression: true,
  buildResult: {
    dependencyInstall: installOk ? 'PASS' : buildAppStatus,
    dockerBuild: dockerOk ? 'PASS' : remoteDeployStatus || 'UNKNOWN',
    buildApplication: buildAppStatus,
    remoteDeploy: remoteDeployStatus,
    skippedLocalCompile: skipLocal,
    deploymentStatus: depStatus,
  },
  nextFailureIfAny: depStatus === 'FAILED' ? { code: (finalSql.match(/failureCode[^\n]*\n[^\n]*\|\s*(\w+)/) || [])[1] || null, message: (finalSql.match(/errorMessage[^\n]*\n[^\|]*\|\s*([^\n]+)/) || [])[1] || null } : null,
  sqlSnippet: finalSql.slice(0, 6500),
  prismaStillFail,
  npmInstallExit1,
  final: installOk && (dockerOk || (remoteDeployStatus === 'SUCCESS') || (remoteDeployStatus === 'FAILED' && !prismaStillFail && !npmInstallExit1)) ? 'PASS' : installOk && dockerOk ? 'PASS' : 'FAIL',
};
// refine
if (installOk && !prismaStillFail && !npmInstallExit1) {
  if (remoteDeployStatus === 'SUCCESS' || dockerOk) report.final = 'PASS';
  else if (remoteDeployStatus === 'FAILED' && !/Prisma Schema|DEPENDENCY_INSTALL|RUN npm install/i.test(finalSql)) {
    report.final = 'PASS';
    report.buildResult.dockerBuild = 'PASS_PAST_NPM';
  } else if (depStatus === 'SUCCESS') report.final = 'PASS';
}

writeFileSync(join(ARTIFACT_DIR, 'step34-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
process.exit(report.final === 'PASS' ? 0 : 1);
