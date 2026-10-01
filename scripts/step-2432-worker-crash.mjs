/**
 * Step 24.3.2 — worker crash mid-deploy then reconcile.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { PrismaClient, ServiceStatus, DeploymentStatus } = require(
  resolve(ROOT, 'packages/database/generated/client'),
);
const { reconcileRemoteRuntimes } = require(resolve(ROOT, 'packages/deployment/dist/index.js'));

const API = 'http://localhost:3001/api/v1';
const PROJECT_ID = 'cmu3j24mv0001ri7wcsoa30hj';
const WEB_UNIT = 'cmu3j27340007ri7wcno1xrai';
const ENV_ID = 'cmu3j5ppc000hri7wvxrjopit';
const SERVER_ID = 'cmu22cqo80007ri6wkt4krfsq';

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'xiaoqiang8699@gmail.com',
      password: 'Launchos123!',
    }),
  });
  return (await res.json()).accessToken;
}

const token = await login();
const prisma = new PrismaClient();
const before = await prisma.serviceInstance.findFirst({
  where: { deployableUnitId: WEB_UNIT, status: ServiceStatus.RUNNING },
  orderBy: { updatedAt: 'desc' },
});

const depRes = await fetch(`${API}/projects/${PROJECT_ID}/deployments`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    environmentId: ENV_ID,
    hostingMode: 'my-server',
    serverInstanceId: SERVER_ID,
    deployableUnitId: WEB_UNIT,
  }),
});
const dep = await depRes.json();
console.log('started', dep.id, dep.status);

// Wait until a CREATING service instance appears (container phase), then kill worker.
let creating = null;
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 1500));
  creating = await prisma.serviceInstance.findFirst({
    where: {
      projectId: PROJECT_ID,
      deployableUnitId: WEB_UNIT,
      status: ServiceStatus.CREATING,
    },
    orderBy: { createdAt: 'desc' },
  });
  const d = await prisma.deployment.findUnique({
    where: { id: dep.id },
    select: { status: true },
  });
  if (creating || d?.status === 'RUNNING') {
    console.log('phase', d?.status, 'creating', Boolean(creating));
    break;
  }
}

// Kill worker processes
const { execSync } = await import('node:child_process');
try {
  execSync(
    `powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'apps\\\\\\\\worker\\\\dist' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
    { stdio: 'ignore' },
  );
} catch {
  // ignore
}
console.log('worker killed');
await new Promise((r) => setTimeout(r, 3000));

// Restart worker
spawn('cmd.exe', ['/c', 'node apps\\worker\\dist\\main.js > .tools\\worker-2432-crash.log 2>&1'], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
}).unref();
await new Promise((r) => setTimeout(r, 12000));

// Force reconcile + wait for deploy finish or fail
const report = await reconcileRemoteRuntimes(prisma);
console.log('reconcile', report);

let finalDep = null;
for (let i = 0; i < 60; i += 1) {
  finalDep = await prisma.deployment.findUnique({
    where: { id: dep.id },
    select: { status: true, errorMessage: true },
  });
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(finalDep?.status)) break;
  await new Promise((r) => setTimeout(r, 4000));
}

const after = await prisma.serviceInstance.findFirst({
  where: { deployableUnitId: WEB_UNIT, status: ServiceStatus.RUNNING },
  orderBy: { updatedAt: 'desc' },
});
const staleCreating = await prisma.serviceInstance.count({
  where: {
    projectId: PROJECT_ID,
    status: ServiceStatus.CREATING,
    updatedAt: { lt: new Date(Date.now() - 60_000) },
  },
});
const https = await fetch('https://web-launchos.zsaos.com/', {
  signal: AbortSignal.timeout(20000),
}).then((r) => r.status);

const pass =
  after?.status === ServiceStatus.RUNNING &&
  https === 200 &&
  staleCreating === 0 &&
  (finalDep?.status === DeploymentStatus.SUCCESS ||
    finalDep?.status === DeploymentStatus.FAILED ||
    finalDep?.status === DeploymentStatus.RUNNING);

console.log(
  JSON.stringify(
    {
      depStatus: finalDep?.status,
      beforeCid: before?.containerId?.slice(0, 12),
      afterCid: after?.containerId?.slice(0, 12),
      staleCreating,
      https,
      reconcileWarnings: report.warnings.length,
      pass,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
process.exit(pass ? 0 : 1);
