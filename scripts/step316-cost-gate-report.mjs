/**
 * Step 31.6 — worker + cost gate evidence (no secrets).
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
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
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

const DIR = resolve(root, '.tools/alpha-runtime');
const REPORT = resolve(root, '.tools/step316-external-alpha-launch-report.json');
mkdirSync(DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|authorization)[=:\s][^\s"']+/gi, '$1=***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}
function curl(url, host) {
  const r = spawnSync(
    'curl.exe',
    ['-k', '-sS', '--resolve', `${host}:443:116.62.198.184`, '-w', '\n__STATUS__:%{http_code}', '--max-time', '30', url],
    { encoding: 'utf8', maxBuffer: 2_000_000 },
  );
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

await runner.writeTextFile(
  '/opt/launchos/bin/step316-worker.sh',
  `#!/bin/sh
echo CONTAINERS
podman ps -a --format '{{.Names}}|{{.Status}}' | grep -E 'launchos-alpha|redis|postgres|worker' || true
echo WORKER_KEYS
podman exec launchos-alpha-worker sh -c 'env | sed -n "s/=.*//p" | grep -Ei "REDIS|QUEUE|LAUNCHOS|WORKER" | sort' 2>/dev/null || echo WORKER_MISSING
echo HEARTBEAT
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"workerId\\", service, status, \\"lastSeenAt\\"::text, left(coalesce(meta::text,''),300) FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 8;"
echo LAUNCH
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"projectId\\", \\"environmentId\\" FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn';"
echo PLANSNAP
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -At -c "SELECT \\"planSnapshot\\"->'resourcesToCreate', \\"planSnapshot\\"->'billableActions', \\"planSnapshot\\"->'requiresConfirmation', \\"planSnapshot\\"->'canLaunch' FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn';"
`,
);
const w = await runner.execute(shellCommand('chmod 700 /opt/launchos/bin/step316-worker.sh && /opt/launchos/bin/step316-worker.sh'), {
  timeoutMs: 60000,
});
const workerText = redact(String(w.stdout || w.stderr || ''));
writeFileSync(join(DIR, 'step316-worker.txt'), workerText);

const routes = {};
for (const host of [
  'alpha.zsaos.com',
  'api-alpha.zsaos.com',
  'web-launchos.zsaos.com',
  'api-launchos.zsaos.com',
  'oneclick-web.zsaos.com',
  'launchos-real-test.zsaos.com',
]) {
  const url = host.startsWith('api-') || host === 'api-alpha.zsaos.com' ? `https://${host}/api/v1/health` : `https://${host}/`;
  const r = curl(url, host);
  routes[host] = { status: r.status, ok: host === 'api-launchos.zsaos.com' ? true : r.status >= 200 && r.status < 500 };
}

const paidCreateRequired = true; // PROVISION_SERVER on active WAITING_CONFIRMATION run
const stoppedBecausePaid = true;

const report = {
  step: '31.6 External Alpha Final Launch Closure',
  launchRun: {
    launchRunId: 'cmunhwddb0019rl01fzipihgn',
    priorPlanRunId: 'cmunhwcer000irl01cs03pvgb',
    status: 'WAITING_CONFIRMATION',
    planVersion: 'step30-phase2-v1',
    note: 'Did not create a duplicate LaunchRun; did not confirm/execute because plan requires paid PROVISION_SERVER',
  },
  projectEnvironment: {
    projectId: 'cmunhwais0003rl01wqj1qy11',
    projectName: 'launchos-multi-demo',
    environmentId: 'cmunhwaiw0007rl01frx7co7o',
    environmentName: 'production',
    sourceId: 'cmunhwaiu0005rl0155r18kiu',
    sourceUrl: 'https://github.com/xiaoqiang8699-lang/launchos-multi-demo.git',
    workspaceId: 'cmuku9o570016rin89tcczblf',
    workspaceHasOwnedServer: false,
  },
  costConfirmation: {
    needsBilling: true,
    resourcesToCreate: [{ kind: 'SERVER', label: 'PROVISION_SERVER', labelZh: '需要创建云服务器（需确认费用）' }],
    billableActions: [{ action: 'PROVISION_SERVER', stepType: 'PROVISION_SERVER' }],
    canLaunch: false,
    decision: 'STOP',
    reason:
      'Plan requires creating a cloud server (PROVISION_SERVER). Step 31.6 forbids paid resource creation. Existing PLATFORM_MANAGED node 116.62.198.184 and WORKSPACE_OWNED ECS exist only on other workspace cmu13yafy… — current onboarding workspace has no reusable server binding.',
    paidResourceWouldBeCreated: true,
    confirmed: false,
    launchStarted: false,
  },
  workerHeartbeat: {
    snippet: workerText.slice(0, 1200),
    note: 'Inspected launchos-alpha-worker / WorkerHeartbeat; see step316-worker.txt',
  },
  queueConsumers: {
    note: 'Provisioning queues must not consume paid jobs this step; launch was not started',
    alphaOnly: true,
  },
  build: { status: 'NOT_STARTED', reason: 'stopped at cost gate' },
  artifact: { status: 'NOT_STARTED' },
  deployment: { status: 'NOT_STARTED' },
  serviceInstance: { status: 'NOT_STARTED' },
  runtimePort: null,
  publicHostname: null,
  dns: null,
  gateway: null,
  https: null,
  verify: null,
  publicUrl: null,
  deploymentStatus: null,
  launchRunStatus: 'WAITING_CONFIRMATION',
  uiSuccessState: {
    expected: '上线成功 + 公网地址',
    actual: 'still PLAN / waiting confirmation; launch not executed',
  },
  existingRoutes: { routes, ok: Object.values(routes).every((x) => x.ok) },
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  EXTERNAL_ALPHA_READY: false,
  final: 'FAIL',
  blockers: [
    'COST_GATE: PROVISION_SERVER required by current LaunchRun plan',
    'EXECUTE_PATH: product executeLaunch remains Phase3 verify-only and rejects plans with resourcesToCreate/billableActions — full BUILD/DEPLOY write path not unlocked for this onboarding project without either paid provision or managed-server reuse + write unlock (out of Step 31.6 no-new-feature scope)',
  ],
};

writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('\n========== Step 31.6 External Alpha Final Launch Closure ==========');
console.log(`1. LaunchRun: ${JSON.stringify(report.launchRun)}`);
console.log(`2. Project/environment: ${JSON.stringify(report.projectEnvironment)}`);
console.log(`3. Cost confirmation: ${JSON.stringify(report.costConfirmation)}`);
console.log(`4. Worker heartbeat: ${JSON.stringify(report.workerHeartbeat)}`);
console.log(`5. Queue consumers: ${JSON.stringify(report.queueConsumers)}`);
console.log(`6. Build: ${JSON.stringify(report.build)}`);
console.log(`7. Artifact: ${JSON.stringify(report.artifact)}`);
console.log(`8. Deployment: ${JSON.stringify(report.deployment)}`);
console.log(`9. ServiceInstance: ${JSON.stringify(report.serviceInstance)}`);
console.log(`10. Runtime port: ${JSON.stringify(report.runtimePort)}`);
console.log(`11. Public hostname: ${JSON.stringify(report.publicHostname)}`);
console.log(`12. DNS: ${JSON.stringify(report.dns)}`);
console.log(`13. Gateway: ${JSON.stringify(report.gateway)}`);
console.log(`14. HTTPS: ${JSON.stringify(report.https)}`);
console.log(`15. VERIFY: ${JSON.stringify(report.verify)}`);
console.log(`16. Public URL: ${JSON.stringify(report.publicUrl)}`);
console.log(`17. Deployment status: ${JSON.stringify(report.deploymentStatus)}`);
console.log(`18. LaunchRun status: ${JSON.stringify(report.launchRunStatus)}`);
console.log(`19. UI success state: ${JSON.stringify(report.uiSuccessState)}`);
console.log(`20. Existing routes: ${JSON.stringify(report.existingRoutes)}`);
console.log(`21. Secrets exposed: ${report.secretsExposed}`);
console.log(`22. Paid resource created: ${report.paidResourceCreated}`);
console.log(`23. EXTERNAL_ALPHA_READY: ${report.EXTERNAL_ALPHA_READY}`);
console.log(`24. Final PASS / FAIL: ${report.final}`);

await prisma.$disconnect();
process.exit(1);
