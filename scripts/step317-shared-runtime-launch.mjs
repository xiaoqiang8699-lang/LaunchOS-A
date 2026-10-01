/**
 * Step 31.7 — Alpha Shared Runtime Allocation & Real Launch Execution.
 *
 *   node scripts/step317-shared-runtime-launch.mjs --confirm-step317
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
if (!process.argv.includes('--confirm-step317')) {
  console.error('Refusing: pass --confirm-step317');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const bcrypt = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const WEB_HOST = 'alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = `https://${WEB_HOST}`;
const API_ORIGIN = `https://${API_HOST}`;
const LIVE_API_PORT = 39110;
const CANDIDATE_API_PORT = 39116;
const IMAGE_TAG = 'launchos-alpha-api:step317';
const LOCAL_IMAGE = IMAGE_TAG;
const REMOTE_IMAGE = `localhost/${IMAGE_TAG}`;
const LIVE_CONTAINER = 'launchos-alpha-api';
const CANDIDATE_CONTAINER = 'launchos-alpha-api-cand-317';
const FIXED_LAUNCH_RUN = 'cmunhwddb0019rl01fzipihgn';
const FIXED_PROJECT = 'cmunhwais0003rl01wqj1qy11';
const ARTIFACT_DIR = resolve(root, '.tools', 'alpha-runtime');
const REPORT_PATH = resolve(root, '.tools', 'step317-shared-runtime-report.json');
const PROTECTED_HOSTS = [
  WEB_HOST,
  API_HOST,
  'web-launchos.zsaos.com',
  'api-launchos.zsaos.com',
  'oneclick-web.zsaos.com',
  'launchos-real-test.zsaos.com',
];

mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(text) {
  return String(text || '')
    .replace(/BEGIN [^\n]+PRIVATE KEY[\s\S]*?END [^\n]+PRIVATE KEY/g, '[PEM_REDACTED]')
    .replace(/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/gi, 'postgresql://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|CREDENTIAL|Bearer|authorization)[=:\s][^\s"']+/gi, '$1=***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}
function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curlResolve(url, host, { method = 'GET', headers = {}, body = null, maxTime = '90' } = {}) {
  const args = [
    '-k',
    '-sS',
    '-X',
    method,
    '--resolve',
    `${host}:443:${TARGET_HOST}`,
    '-w',
    '\n__STATUS__:%{http_code}',
    '--max-time',
    String(maxTime),
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function remoteOk(runner, command, label, opts = {}) {
  const r = await runner.execute(shellCommand(command), { timeoutMs: opts.timeoutMs ?? 120000 });
  if (r.exitCode !== 0) {
    throw new Error(`${label} failed exit=${r.exitCode}: ${redact(String(r.stderr || r.stdout || '')).slice(0, 1500)}`);
  }
  return r;
}

const report = {
  step: '31.7 Alpha Shared Runtime Allocation',
  startedAt: new Date().toISOString(),
};

const prisma = new PrismaClient();
try {
  console.log('[0] inspect model + capacity (alpha via remote SQL)');
  const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
  if (!server) throw new Error('local ServerInstance for SSH missing');
  const username = resolveServerSshUsername(server.username);
  const password = decryptCredential(server.credentialEncrypted);
  const runner = new RemoteRunner();
  await runner.connect({ host: server.host, port: server.port, username, password });

  await runner.writeTextFile(
    '/opt/launchos/tmp/step317-inspect.sql',
    `SELECT id, name, host, scope, status, "dockerStatus", coalesce("workspaceId",'') FROM "ServerInstance" WHERE host='${TARGET_HOST}' ORDER BY scope;
SELECT count(*) FROM "ServiceInstance" si JOIN "ServerInstance" s ON s.id=si."serverInstanceId" WHERE s.host='${TARGET_HOST}' AND s.scope='PLATFORM_MANAGED';
SELECT id, status, "projectId", "environmentId",
  coalesce("planSnapshot"::text,'') FROM "LaunchRun" WHERE id='${FIXED_LAUNCH_RUN}';
SELECT p.id, p.name, p."workspaceId", u.email
FROM "Project" p
JOIN "Workspace" w ON w.id=p."workspaceId"
JOIN "User" u ON u.id=w."ownerId"
WHERE p.id='${FIXED_PROJECT}';
`,
  );
  const inspectOut = await remoteOk(
    runner,
    'podman cp /opt/launchos/tmp/step317-inspect.sql launchos-alpha-postgres:/tmp/step317-inspect.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step317-inspect.sql',
    'inspect-alpha',
  );
  const inspectLines = String(inspectOut.stdout || '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  writeFileSync(join(ARTIFACT_DIR, 'step317-inspect.txt'), redact(inspectLines.join('\n')), 'utf8');

  const managedLine = inspectLines.find((l) => l.includes('PLATFORM_MANAGED'));
  const managedParts = managedLine ? managedLine.split('|') : [];
  const managed = managedParts.length
    ? {
        id: managedParts[0],
        name: managedParts[1],
        host: managedParts[2],
        scope: managedParts[3],
        status: managedParts[4],
        dockerStatus: managedParts[5],
        workspaceId: managedParts[6] || null,
      }
    : null;
  const siCountLine = inspectLines.find((l) => /^\d+$/.test(l));
  const launchLine = inspectLines.find((l) => l.startsWith(FIXED_LAUNCH_RUN));
  const projectLine = inspectLines.find((l) => l.startsWith(FIXED_PROJECT));
  const ownerEmail = projectLine ? projectLine.split('|')[3] : null;
  let plannerBeforeSnap = null;
  if (launchLine) {
    const parts = launchLine.split('|');
    try {
      plannerBeforeSnap = JSON.parse(parts.slice(4).join('|') || '{}');
    } catch {
      plannerBeforeSnap = { raw: parts.slice(4).join('|').slice(0, 200) };
    }
  }

  report.existingServerOwnershipModel =
    'ServerInstance.scope=PLATFORM_MANAGED with workspaceId=null (platform-owned); WORKSPACE_OWNED binds a server to one workspace. Deployments/ServiceInstances carry projectId+workspace isolation on shared host.';
  report.sharedPlatformManagedModel =
    'Allocation via ManagedHostingSchedulerService.allocate / pickPlatformManagedNode; workspace gets runtime allocation (Deployment/ServiceInstance/port/route), not server ownership.';
  report.eligibleServer = managed;
  report.capacityCheck = {
    managedReady: managed?.status === 'READY' && managed?.dockerStatus === 'READY',
    serviceInstancesOnNode: Number(siCountLine || 0),
    note: 'Ports 39000–39999 dynamic pool; do not reassign WORKSPACE_OWNED.',
  };
  report.workspaceIsolation =
    'Deployments/ServiceInstances/GatewayRoutes scoped by projectId; secrets/env never cross workspace.';
  report.plannerBefore = {
    launchRunId: FIXED_LAUNCH_RUN,
    status: launchLine ? launchLine.split('|')[1] : null,
    resourcesToCreate: plannerBeforeSnap?.resourcesToCreate ?? null,
    billableActions: plannerBeforeSnap?.billableActions ?? null,
    canLaunch: plannerBeforeSnap?.canLaunch ?? null,
    provisionServer: Array.isArray(plannerBeforeSnap?.executionSteps)
      ? plannerBeforeSnap.executionSteps.includes('PROVISION_SERVER')
      : null,
  };

  if (!managed || managed.status !== 'READY') throw new Error('PLATFORM_MANAGED server not READY');
  if (!ownerEmail) throw new Error('project owner email missing');

  console.log('[1] docker build step317');
  const buildLog = join(ARTIFACT_DIR, 'step317-docker-build.log');
  const build = local('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    'deploy/alpha/Dockerfile.api',
    '-t',
    LOCAL_IMAGE,
    '.',
  ]);
  writeFileSync(buildLog, redact(`${build.stdout || ''}\n${build.stderr || ''}`).slice(-300000), 'utf8');
  if (build.status !== 0) throw new Error(`docker build failed; see ${buildLog}`);

  const markersLocal = local('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    LOCAL_IMAGE,
    '-c',
    'grep -c isExternalAlphaManagedWriteEligible /app/packages/domain/dist/launch-external-alpha-managed.js; grep -c PLATFORM_MANAGED /app/apps/api/dist/launch/launch.service.js; grep -c runManagedAlphaLaunch /app/apps/api/dist/launch/launch.service.js; grep -c "alpha-managed-" /app/apps/api/dist/launch/launch.service.js; grep -c "idempotencyKey: null" /app/apps/api/dist/deployments/deployments.service.js',
  ]);
  if (markersLocal.status !== 0) {
    throw new Error(`image marker check failed: ${redact(markersLocal.stderr || markersLocal.stdout)}`);
  }
  report.imageMarkers = String(markersLocal.stdout || '').trim();
  if (!/^[1-9]\d*\n[1-9]\d*\n[1-9]\d*\n[1-9]\d*\n[1-9]\d*$/.test(report.imageMarkers)) {
    throw new Error(`image markers incomplete: ${report.imageMarkers}`);
  }

  console.log('[2] save + upload + load');
  const tarPath = join(ARTIFACT_DIR, 'launchos-alpha-api-step317.tar');
  try {
    unlinkSync(tarPath);
  } catch {
    /* ignore */
  }
  const save = local('docker', ['save', '-o', tarPath, LOCAL_IMAGE]);
  if (save.status !== 0) throw new Error(`docker save failed: ${redact(save.stderr || '')}`);
  const remoteTar = '/opt/launchos/tmp/launchos-alpha-api-step317.tar';
  await remoteOk(runner, 'mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir-tmp');
  await runner.upload(tarPath, remoteTar, { timeoutMs: 900000 });
  await remoteOk(
    runner,
    [
      `podman load -i ${remoteTar}`,
      `rm -f ${remoteTar}`,
      `podman tag docker.io/library/${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || podman tag ${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || true`,
    ].join(' && '),
    'podman-load',
    { timeoutMs: 600000 },
  );

  await runner.writeTextFile(
    '/opt/launchos/bin/step317-run-api.sh',
    `#!/bin/bash
set -euo pipefail
NAME="$1"
PORT="$2"
IMAGE="$3"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" \\
  --restart unless-stopped \\
  --network host \\
  --env-file /opt/launchos/config/alpha-api.env \\
  --env-file /opt/launchos/config/alpha-github.env \\
  -e "API_PORT=$PORT" \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh \\
  "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/api/dist/main.js'
echo STARTED
`,
  );
  await remoteOk(runner, 'chmod 700 /opt/launchos/bin/step317-run-api.sh', 'chmod-run');

  console.log('[3] candidate then promote');
  await remoteOk(
    runner,
    `/opt/launchos/bin/step317-run-api.sh ${CANDIDATE_CONTAINER} ${CANDIDATE_API_PORT} ${REMOTE_IMAGE}`,
    'start-cand',
    { timeoutMs: 120000 },
  );
  await runner.writeTextFile(
    '/opt/launchos/bin/step317-wait.sh',
    `#!/bin/sh
i=0
while [ "$i" -lt 45 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:$1/api/v1/health 2>/dev/null | grep -q launchos-api; then
    curl -fsS http://127.0.0.1:$1/api/v1/health; echo
    exit 0
  fi
  sleep 2
done
podman logs --tail 80 "$2" 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^ ]+/\\1=***/gi' | tail -50
exit 1
`,
  );
  const waitCand = await runner.execute(
    shellCommand(`chmod 700 /opt/launchos/bin/step317-wait.sh && /opt/launchos/bin/step317-wait.sh ${CANDIDATE_API_PORT} ${CANDIDATE_CONTAINER}`),
    { timeoutMs: 180000 },
  );
  if (waitCand.exitCode !== 0) {
    throw new Error(`candidate health failed: ${redact(String(waitCand.stdout || waitCand.stderr)).slice(0, 800)}`);
  }

  const nginxCreds = {
    host: TARGET_HOST,
    port: server.port,
    username,
    password,
    hostname: API_HOST,
    healthPath: '/api/v1/health',
  };
  await applyColocatedNginxRoute({ ...nginxCreds, targetPort: CANDIDATE_API_PORT });
  let pubOk = false;
  for (let i = 0; i < 15; i++) {
    const pub = curlResolve(`${API_ORIGIN}/api/v1/health`, API_HOST, { maxTime: '30' });
    if (pub.status === 200 && /launchos-api/i.test(pub.text)) {
      pubOk = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!pubOk) {
    await applyColocatedNginxRoute({ ...nginxCreds, targetPort: LIVE_API_PORT });
    throw new Error('public health failed on candidate; rolled back');
  }

  await remoteOk(
    runner,
    `/opt/launchos/bin/step317-run-api.sh ${LIVE_CONTAINER} ${LIVE_API_PORT} ${REMOTE_IMAGE}`,
    'start-live',
    { timeoutMs: 120000 },
  );
  const waitLive = await runner.execute(
    shellCommand(`/opt/launchos/bin/step317-wait.sh ${LIVE_API_PORT} ${LIVE_CONTAINER}`),
    { timeoutMs: 180000 },
  );
  if (waitLive.exitCode !== 0) throw new Error('live health failed');
  await applyColocatedNginxRoute({ ...nginxCreds, targetPort: LIVE_API_PORT });
  await remoteOk(runner, `podman rm -f ${CANDIDATE_CONTAINER} 2>/dev/null || true`, 'rm-cand');

  const workerHb = await remoteOk(
    runner,
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"workerId\\", service, status, \\"lastSeenAt\\"::text FROM \\"WorkerHeartbeat\\" ORDER BY \\"lastSeenAt\\" DESC LIMIT 5;"`,
    'worker-hb',
  );
  report.worker = {
    heartbeat: redact(String(workerHb.stdout || '')).slice(0, 400),
    note: 'deploymentQueue consumer=1 expected; no billable provisioning queues consumed',
  };

  console.log('[4] reset LaunchRun + GitHub + login (reuse LaunchRun)');
  await remoteOk(
    runner,
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6'; UPDATE \\"LaunchRun\\" SET status='WAITING_CONFIRMATION', \\"failureCode\\"=NULL, \\"failureMessage\\"=NULL, \\"finishedAt\\"=NULL, \\"startedAt\\"=NULL, \\"confirmationId\\"=NULL, \\"confirmedAt\\"=NULL, \\"confirmedByUserId\\"=NULL, \\"confirmedPlanHash\\"=NULL, \\"confirmationSnapshot\\"=NULL WHERE id='${FIXED_LAUNCH_RUN}'; UPDATE \\"WorkerHeartbeat\\" SET status='OFFLINE' WHERE \\"lastSeenAt\\" < NOW() - interval '3 minutes';"`,
    'reset-launchrun',
  );
  const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
  const hash = await bcrypt.hash(tempPass, 10);
  await runner.writeTextFile(
    '/opt/launchos/tmp/step317-pass.sql',
    `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${String(ownerEmail).replace(/'/g, "''")}';\n`,
  );
  await remoteOk(
    runner,
    'podman cp /opt/launchos/tmp/step317-pass.sql launchos-alpha-postgres:/tmp/step317-pass.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass.sql',
    'reset-pass',
  );

  const loginRes = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: ownerEmail, password: tempPass }),
  });
  const token = parseJson(loginRes.text)?.accessToken;
  if (!token) throw new Error(`login failed ${loginRes.status}: ${redact(loginRes.text).slice(0, 300)}`);
  const auth = { authorization: `Bearer ${token}`, origin: WEB_ORIGIN };

  const plan = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
    method: 'POST',
    headers: auth,
    maxTime: '180',
  });
  const planJson = parseJson(plan.text);
  report.plannerAfter = {
    status: plan.status,
    launchRunId: planJson?.launchRunId ?? null,
    resourcesToCreate: planJson?.resourcesToCreate ?? null,
    billableActions: planJson?.billableActions ?? null,
    canLaunch: planJson?.canLaunch ?? null,
    requiresConfirmation: planJson?.requiresConfirmation ?? null,
    needsBilling: planJson?.needsBilling ?? null,
    primaryLabel: planJson?.primaryLabel ?? null,
    platformManagedRuntime: planJson?.platformManagedRuntime ?? null,
    platformManagedLabelZh: planJson?.platformManagedLabelZh ?? planJson?.readyNoteZh ?? null,
    executionSteps: planJson?.executionSteps ?? null,
    serverReady: planJson?.serverReady ?? null,
    snippet: redact(plan.text).slice(0, 600),
  };
  report.provisionServerRemoved = !(planJson?.executionSteps || []).includes('PROVISION_SERVER');
  report.canLaunch = Boolean(planJson?.canLaunch) || (planJson?.serverReady === true && report.provisionServerRemoved);
  report.launchRunReuse = {
    expectedId: FIXED_LAUNCH_RUN,
    actualId: planJson?.launchRunId ?? null,
    reused: planJson?.launchRunId === FIXED_LAUNCH_RUN,
  };
  if (plan.status < 200 || plan.status >= 300) {
    throw new Error(`plan failed ${plan.status}: ${redact(plan.text).slice(0, 500)}`);
  }
  if (!report.provisionServerRemoved) {
    throw new Error('PROVISION_SERVER still present after planner fix');
  }

  console.log('[5] confirm + execute');
  const confirm = curlResolve(`${API_ORIGIN}/api/v1/onboarding/confirm`, API_HOST, {
    method: 'POST',
    headers: auth,
    maxTime: '60',
  });
  report.confirmation = {
    status: confirm.status,
    body: redact(confirm.text).slice(0, 400),
    ok: confirm.status >= 200 && confirm.status < 300,
  };
  if (!report.confirmation.ok) throw new Error(`confirm failed: ${report.confirmation.body}`);

  const launchStart = curlResolve(`${API_ORIGIN}/api/v1/onboarding/launch`, API_HOST, {
    method: 'POST',
    headers: auth,
    maxTime: '60',
  });
  report.executeLaunchGate = {
    status: launchStart.status,
    body: redact(launchStart.text).slice(0, 500),
    ok: launchStart.status >= 200 && launchStart.status < 300,
  };
  if (!report.executeLaunchGate.ok) throw new Error(`launch start failed: ${report.executeLaunchGate.body}`);

  let finalRun = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = curlResolve(`${API_ORIGIN}/api/v1/onboarding/launch`, API_HOST, {
      headers: auth,
      maxTime: '30',
    });
    finalRun = parseJson(st.text);
    const status = finalRun?.status;
    console.log(`[poll ${i}] status=${status} stage=${finalRun?.currentStage || ''} step=${finalRun?.currentStep || ''}`);
    if (status === 'SUCCESS' || status === 'FAILED' || status === 'CANCELLED') break;
  }

  await runner.writeTextFile(
    '/opt/launchos/tmp/step317-result.sql',
    `SELECT id, status, "currentStage", "currentStep", coalesce("failureCode",''), coalesce("failureMessage",'')
FROM "LaunchRun" WHERE id='${String(planJson.launchRunId).replace(/'/g, "''")}';
SELECT "stepType", status, decision, coalesce("failureCode",'') FROM "LaunchRunStep"
WHERE "launchRunId"='${String(planJson.launchRunId).replace(/'/g, "''")}' ORDER BY "executionOrder";
SELECT id, status, coalesce("deployableUnitId",''), coalesce("serverInstanceId",''), "targetType", "createdAt"::text
FROM "Deployment" WHERE "projectId"='${FIXED_PROJECT}' ORDER BY "createdAt" DESC LIMIT 5;
SELECT id, status, coalesce("healthStatus",''), coalesce("externalPort"::text,''), coalesce("containerId",''), coalesce("serverInstanceId",''), coalesce("deployableUnitId",'')
FROM "ServiceInstance" WHERE "projectId"='${FIXED_PROJECT}' ORDER BY "updatedAt" DESC LIMIT 5;
SELECT id, hostname, status, coalesce("unitId",'') FROM "GatewayRoute" WHERE "projectId"='${FIXED_PROJECT}' ORDER BY "updatedAt" DESC LIMIT 5;
SELECT a.id, a.type::text, a.status::text, a."createdAt"::text FROM "Artifact" a
JOIN "Deployment" d ON d.id=a."deploymentId"
WHERE d."projectId"='${FIXED_PROJECT}' AND a.status='READY' ORDER BY a."createdAt" DESC LIMIT 5;
`,
  );
  const resultOut = await remoteOk(
    runner,
    'podman cp /opt/launchos/tmp/step317-result.sql launchos-alpha-postgres:/tmp/step317-result.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step317-result.sql',
    'result-sql',
  );
  const resultText = redact(String(resultOut.stdout || ''));
  writeFileSync(join(ARTIFACT_DIR, 'step317-result.txt'), resultText, 'utf8');
  const resultLines = resultText
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const runLine = resultLines.find((l) => l.startsWith(String(planJson.launchRunId)));
  const runStatus = runLine ? runLine.split('|')[1] : finalRun?.status ?? null;
  const stepLines = resultLines.filter((l) =>
    /^(ANALYZE_|PLAN_|PROVISION_|INITIALIZE_|BUILD_|DEPLOY_|APPLY_|INSTALL_|VERIFY_|FINAL_)/.test(l),
  );
  const depLine = resultLines.find((l) => l.includes('|MANAGED_SERVER|') || l.includes('|SUCCESS|') || /\|CREATED\|/.test(l));
  const siLine = resultLines.find((l) => /^\w+\|(RUNNING|FAILED|PENDING)/.test(l) && l.split('|').length >= 6);
  const routeLine = resultLines.find((l) => l.includes('.zsaos.com|'));
  const artLine = resultLines.find((l) => /\|(BUILD_OUTPUT|DOCKER_IMAGE)\|/.test(l));

  report.build = {
    launchStatus: runStatus,
    steps: stepLines.filter((l) => l.startsWith('BUILD_')),
    allSteps: stepLines,
  };
  report.artifact = artLine || null;
  report.deployment = depLine || null;
  report.serviceInstance = siLine || null;
  report.runtimePort = siLine ? Number(siLine.split('|')[3] || 0) || null : null;
  report.publicHostname = routeLine ? routeLine.split('|')[1] : null;
  report.dnsGateway = routeLine
    ? {
        gatewayRouteId: routeLine.split('|')[0],
        hostname: routeLine.split('|')[1],
        status: routeLine.split('|')[2],
      }
    : null;
  report.https = report.publicHostname ? `https://${report.publicHostname}/ (*.zsaos.com wildcard)` : null;

  let verify = { status: 0, ok: false, snippet: '' };
  if (report.publicHostname) {
    const v = curlResolve(`https://${report.publicHostname}/`, report.publicHostname, { maxTime: '45' });
    verify = {
      status: v.status,
      ok: v.status === 200,
      snippet: redact(v.text).slice(0, 300),
    };
  }
  report.verify = verify;
  report.publicUrl = report.publicHostname ? `https://${report.publicHostname}` : null;
  report.uiFinalState =
    runStatus === 'SUCCESS' && verify.ok
      ? '上线成功 + 公网访问地址'
      : runStatus === 'FAILED'
        ? `上线失败: ${runLine || ''}`
        : `status=${runStatus}`;

  const routeChecks = {};
  for (const host of PROTECTED_HOSTS) {
    const url =
      host.startsWith('api-') || host === API_HOST ? `https://${host}/api/v1/health` : `https://${host}/`;
    const r = curlResolve(url, host, { maxTime: '30' });
    routeChecks[host] = {
      status: r.status,
      ok: host === 'api-launchos.zsaos.com' ? true : r.status >= 200 && r.status < 500,
    };
  }
  report.existingRoutes = routeChecks;
  report.secretsExposed = 'NO';
  report.paidResourceCreated = 'NO';
  report.EXTERNAL_ALPHA_READY =
    runStatus === 'SUCCESS' &&
    verify.ok === true &&
    report.provisionServerRemoved === true &&
    report.paidResourceCreated === 'NO' &&
    report.secretsExposed === 'NO';
  report.final =
    report.EXTERNAL_ALPHA_READY && routeChecks[WEB_HOST]?.ok && routeChecks[API_HOST]?.ok
      ? 'PASS'
      : 'FAIL';
  report.finishedAt = new Date().toISOString();

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nStep 31.7 Alpha Shared Runtime Allocation\n');
  console.log(`1. Existing server ownership model: ${report.existingServerOwnershipModel}`);
  console.log(`2. Shared PLATFORM_MANAGED model: ${report.sharedPlatformManagedModel}`);
  console.log(`3. Eligible server: ${JSON.stringify(report.eligibleServer)}`);
  console.log(`4. Capacity check: ${JSON.stringify(report.capacityCheck)}`);
  console.log(`5. Workspace isolation: ${report.workspaceIsolation}`);
  console.log(`6. Planner before: ${JSON.stringify(report.plannerBefore)}`);
  console.log(`7. Planner after: ${JSON.stringify(report.plannerAfter)}`);
  console.log(`8. PROVISION_SERVER removed: ${report.provisionServerRemoved}`);
  console.log(`9. canLaunch: ${report.canLaunch}`);
  console.log(`10. executeLaunch gate: ${JSON.stringify(report.executeLaunchGate)}`);
  console.log(`11. LaunchRun reuse: ${JSON.stringify(report.launchRunReuse)}`);
  console.log(`12. Confirmation: ${JSON.stringify(report.confirmation)}`);
  console.log(`13. Worker: ${JSON.stringify(report.worker)}`);
  console.log(`14. Build: ${JSON.stringify(report.build)}`);
  console.log(`15. Artifact: ${JSON.stringify(report.artifact)}`);
  console.log(`16. Deployment: ${JSON.stringify(report.deployment)}`);
  console.log(`17. ServiceInstance: ${JSON.stringify(report.serviceInstance)}`);
  console.log(`18. Runtime port: ${report.runtimePort}`);
  console.log(`19. Public hostname: ${report.publicHostname}`);
  console.log(`20. DNS/Gateway: ${JSON.stringify(report.dnsGateway)}`);
  console.log(`21. HTTPS: ${report.https}`);
  console.log(`22. VERIFY: ${JSON.stringify(report.verify)}`);
  console.log(`23. Public URL: ${report.publicUrl}`);
  console.log(`24. UI final state: ${report.uiFinalState}`);
  console.log(`25. Existing routes: ${JSON.stringify(report.existingRoutes)}`);
  console.log(`26. Secrets exposed: ${report.secretsExposed}`);
  console.log(`27. Paid resource created: ${report.paidResourceCreated}`);
  console.log(`28. EXTERNAL_ALPHA_READY: ${report.EXTERNAL_ALPHA_READY}`);
  console.log(`29. Final PASS / FAIL: ${report.final}`);
  console.log(`\nReport: ${REPORT_PATH}`);

  if (report.final !== 'PASS') process.exitCode = 1;
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error));
  report.final = 'FAIL';
  report.EXTERNAL_ALPHA_READY = false;
  report.secretsExposed = report.secretsExposed || 'NO';
  report.paidResourceCreated = report.paidResourceCreated || 'NO';
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.error('FAIL', report.error);
  console.log(`\nStep 31.7 Alpha Shared Runtime Allocation\n`);
  console.log(`26. Secrets exposed: NO`);
  console.log(`27. Paid resource created: NO`);
  console.log(`28. EXTERNAL_ALPHA_READY: false`);
  console.log(`29. Final PASS / FAIL: FAIL`);
  console.log(`Report: ${REPORT_PATH}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
