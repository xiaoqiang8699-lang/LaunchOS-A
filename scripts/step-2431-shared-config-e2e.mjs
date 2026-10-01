/**
 * Step 24.3.1 — Project shared config real E2E (no secret plaintext in output).
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { PrismaClient } = require(resolve(ROOT, 'packages/database/generated/client'));

const API = process.env.API_BASE || 'http://localhost:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const WEB_UNIT = process.env.E2E_WEB_UNIT || 'cmu3j27340007ri7wcno1xrai';
const API_UNIT = process.env.E2E_API_UNIT || 'cmu3j272x0005ri7wlxlbajeu';
const ENV_ID = process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';
const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';

const SENTRY_A = process.env.E2E_SENTRY_A || 'https://placeholder.invalid/sentry-a';
const SENTRY_B = process.env.E2E_SENTRY_B || 'https://placeholder.invalid/sentry-b';
const SENTRY_C = process.env.E2E_SENTRY_C || 'https://placeholder.invalid/sentry-c';
const DB_URL = process.env.E2E_DATABASE_URL || 'postgresql://e2e:e2e@127.0.0.1:5432/e2e_test';

const FORBIDDEN = [SENTRY_A, SENTRY_B, SENTRY_C, DB_URL, 'JWT_SECRET', 'sk-'];

const results = [];
const log = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
};

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json?.message || res.statusText);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function login() {
  const data = await api('/auth/login', {
    method: 'POST',
    body: {
      email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
      password: process.env.E2E_PASSWORD || 'Launchos123!',
    },
  });
  return data.accessToken;
}

function reqByKey(payload, key) {
  return payload.requirements.find((item) => item.key === key);
}

async function unitConfig(token, unitId) {
  return api(`/projects/${PROJECT_ID}/units/${unitId}/config-requirements`, { token });
}

async function getRevisions() {
  const prisma = new PrismaClient();
  try {
    const [web, apiUnit, project] = await Promise.all([
      prisma.deployableUnit.findUnique({
        where: { id: WEB_UNIT },
        select: { configRevision: true },
      }),
      prisma.deployableUnit.findUnique({
        where: { id: API_UNIT },
        select: { configRevision: true },
      }),
      prisma.project.findUnique({
        where: { id: PROJECT_ID },
        select: { sharedConfigRevision: true },
      }),
    ]);
    return {
      webRev: web?.configRevision ?? 0,
      apiRev: apiUnit?.configRevision ?? 0,
      sharedRev: project?.sharedConfigRevision ?? 0,
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function countUnitDeployments(unitId) {
  const prisma = new PrismaClient();
  try {
    return prisma.deployment.count({
      where: { projectId: PROJECT_ID, deployableUnitId: unitId },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function getService(unitId) {
  const prisma = new PrismaClient();
  try {
    return prisma.serviceInstance.findFirst({
      where: { projectId: PROJECT_ID, deployableUnitId: unitId, status: 'RUNNING' },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        status: true,
        healthStatus: true,
        containerId: true,
        configRevision: true,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function waitDeployment(token, depId, timeoutSec = 420) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const d = await api(`/deployments/${depId}`, { token });
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(d.status)) return d;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return api(`/deployments/${depId}`, { token });
}

async function deployUnit(token, unitId, attempt = 1) {
  const body = {
    environmentId: ENV_ID,
    hostingMode: 'my-server',
    serverInstanceId: SERVER_ID,
    deployableUnitId: unitId,
  };
  const dep = await api(`/projects/${PROJECT_ID}/deployments`, {
    method: 'POST',
    token,
    body,
  });
  if (!dep.bullmqJobId) {
    throw new Error(`deployment ${dep.id} missing bullmqJobId`);
  }
  const done = await waitDeployment(token, dep.id);
  if (
    done.status === 'FAILED' &&
    /EBUSY|resource busy/i.test(done.errorMessage || '') &&
    attempt < 4
  ) {
    await new Promise((r) => setTimeout(r, 8000 * attempt));
    return deployUnit(token, unitId, attempt + 1);
  }
  return { created: dep, done };
}

async function scanLogsForSecrets() {
  const fs = await import('node:fs/promises');
  const paths = [
    '.tools/api-e2e-2431.log',
    '.tools/worker-e2e-2431.log',
    '.tools/api-e2e.log',
    '.tools/worker-e2e.log',
  ];
  let hits = 0;
  for (const rel of paths) {
    try {
      const content = await fs.readFile(resolve(ROOT, rel), 'utf8');
      for (const needle of FORBIDDEN) {
        if (needle.length > 8 && content.includes(needle)) hits += 1;
      }
    } catch {
      // ignore missing
    }
  }
  return hits;
}

async function checkRemoteEnvFiles() {
  const { RemoteRunner } = require(resolve(ROOT, 'packages/remote-runner/dist/index.js'));
  const pass = process.env.PROBE_PASS;
  if (!pass) return { skipped: true, remaining: null };
  const runner = new RemoteRunner();
  await runner.connect({
    host: process.env.PROBE_HOST || '8.138.113.134',
    port: 22,
    username: process.env.PROBE_USER || 'root',
    password: pass,
  });
  const out = await runner.execute(
    'ls /tmp/launchos-env-* 2>/dev/null | wc -l',
    { timeoutMs: 15000 },
  );
  await runner.disconnect();
  const remaining = Number.parseInt((out.stdout || '0').trim(), 10);
  return { skipped: false, remaining: Number.isNaN(remaining) ? -1 : remaining };
}

async function main() {
  const token = await login();
  const qs = await api('/system/queue-status', { token });
  log('0-worker-online', qs.workerOnline === true, `workerOnline=${qs.workerOnline}`);

  // Rescan for SENTRY_DSN requirements (git workspace should already be at 07c5e6f+)
  await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config/rescan`, {
    method: 'POST',
    token,
  });
  await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/rescan`, {
    method: 'POST',
    token,
  });
  await new Promise((r) => setTimeout(r, 1500));

  let webAfterScan = await unitConfig(token, WEB_UNIT);
  let apiAfterScan = await unitConfig(token, API_UNIT);
  let webHasSentry = Boolean(reqByKey(webAfterScan, 'SENTRY_DSN'));
  let apiHasSentry = Boolean(reqByKey(apiAfterScan, 'SENTRY_DSN'));
  if (!webHasSentry || !apiHasSentry) {
    await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config/rescan`, {
      method: 'POST',
      token,
    });
    await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/rescan`, {
      method: 'POST',
      token,
    });
    await new Promise((r) => setTimeout(r, 1500));
    webAfterScan = await unitConfig(token, WEB_UNIT);
    apiAfterScan = await unitConfig(token, API_UNIT);
    webHasSentry = Boolean(reqByKey(webAfterScan, 'SENTRY_DSN'));
    apiHasSentry = Boolean(reqByKey(apiAfterScan, 'SENTRY_DSN'));
  }
  log(
    '1-sentry-requirements',
    webHasSentry && apiHasSentry,
    `web=${webHasSentry} api=${apiHasSentry}`,
  );
  if (!webHasSentry || !apiHasSentry) {
    throw new Error('SENTRY_DSN requirements missing after rescan');
  }

  // Baseline: API requires DATABASE_URL for deploy; keep JWT at unit scope from prior runs.
  await api(`/projects/${PROJECT_ID}/config/DATABASE_URL`, {
    method: 'PUT',
    token,
    body: { value: DB_URL },
  });

  const rev0 = await getRevisions();
  const webSvc0 = await getService(WEB_UNIT);
  const apiSvc0 = await getService(API_UNIT);

  // Step 2: Project shared SENTRY_DSN = A
  await api(`/projects/${PROJECT_ID}/config/SENTRY_DSN`, {
    method: 'PUT',
    token,
    body: { value: SENTRY_A },
  });
  const rev1 = await getRevisions();
  const webCfg1 = await unitConfig(token, WEB_UNIT);
  const apiCfg1 = await unitConfig(token, API_UNIT);
  const webS1 = reqByKey(webCfg1, 'SENTRY_DSN');
  const apiS1 = reqByKey(apiCfg1, 'SENTRY_DSN');
  log(
    '2-project-sentry-a',
    webS1?.resolvedSource === 'PROJECT' &&
      apiS1?.resolvedSource === 'PROJECT' &&
      rev1.webRev > rev0.webRev &&
      rev1.apiRev > rev0.apiRev &&
      webS1?.needsRedeploy === true &&
      apiS1?.needsRedeploy === true,
    `web=${webS1?.resolvedSource} rev ${rev0.webRev}->${rev1.webRev} pending=${webS1?.needsRedeploy}; api=${apiS1?.resolvedSource} rev ${rev0.apiRev}->${rev1.apiRev} pending=${apiS1?.needsRedeploy}; sharedRev=${rev1.sharedRev}`,
  );

  // Step 3: Deploy Web then API via BullMQ
  const webDep = await deployUnit(token, WEB_UNIT);
  log(
    '3-deploy-web',
    webDep.done.status === 'SUCCESS',
    `dep=${webDep.created.id} job=${webDep.created.bullmqJobId} status=${webDep.done.status}`,
  );
  const apiDep = await deployUnit(token, API_UNIT);
  log(
    '3-deploy-api',
    apiDep.done.status === 'SUCCESS',
    `dep=${apiDep.created.id} job=${apiDep.created.bullmqJobId} status=${apiDep.done.status}`,
  );

  const webSvc1 = await getService(WEB_UNIT);
  const apiSvc1 = await getService(API_UNIT);
  log(
    '3-services-running',
    webSvc1?.status === 'RUNNING' && apiSvc1?.status === 'RUNNING',
    `web=${webSvc1?.status}/${webSvc1?.healthStatus} api=${apiSvc1?.status}/${apiSvc1?.healthStatus}`,
  );

  const webCfgApplied = await unitConfig(token, WEB_UNIT);
  const apiCfgApplied = await unitConfig(token, API_UNIT);
  const webSApplied = reqByKey(webCfgApplied, 'SENTRY_DSN');
  const apiSApplied = reqByKey(apiCfgApplied, 'SENTRY_DSN');
  log(
    '3-applied-status',
    webSApplied?.applyStatus === 'applied' && apiSApplied?.applyStatus === 'applied',
    `web=${webSApplied?.applyStatus} api=${apiSApplied?.applyStatus}`,
  );

  // Step 4: API config-check
  const cfgCheck1 = await fetch('https://api-launchos.zsaos.com/config-check').then((r) => r.json());
  log(
    '4-api-sentry-configured',
    cfgCheck1.sentryConfigured === true,
    `sentryConfigured=${cfgCheck1.sentryConfigured}`,
  );
  log(
    '4-web-source-project',
    webSApplied?.resolvedSource === 'PROJECT',
    `webSource=${webSApplied?.resolvedSource}`,
  );

  // Step 5: API override B
  const revBeforeOverride = await getRevisions();
  await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/SENTRY_DSN`, {
    method: 'PUT',
    token,
    body: { value: SENTRY_B },
  });
  const revAfterOverride = await getRevisions();
  const webCfg2 = await unitConfig(token, WEB_UNIT);
  const apiCfg2 = await unitConfig(token, API_UNIT);
  const webS2 = reqByKey(webCfg2, 'SENTRY_DSN');
  const apiS2 = reqByKey(apiCfg2, 'SENTRY_DSN');
  log(
    '5-api-override',
    apiS2?.resolvedSource === 'UNIT' &&
      apiS2?.hasUnitOverride === true &&
      apiS2?.needsRedeploy === true &&
      webS2?.resolvedSource === 'PROJECT' &&
      revAfterOverride.apiRev > revBeforeOverride.apiRev &&
      revAfterOverride.webRev === revBeforeOverride.webRev,
    `api=${apiS2?.resolvedSource} override=${apiS2?.hasUnitOverride}; web=${webS2?.resolvedSource}; rev web ${revBeforeOverride.webRev}->${revAfterOverride.webRev} api ${revBeforeOverride.apiRev}->${revAfterOverride.apiRev}`,
  );

  const webRevBeforeApiOnly = (await getRevisions()).webRev;
  const webDepCountBefore = await countUnitDeployments(WEB_UNIT);
  const apiOverrideDep = await deployUnit(token, API_UNIT);
  const webDepCountAfter = await countUnitDeployments(WEB_UNIT);
  const webRevAfterApiOnly = (await getRevisions()).webRev;
  const apiSvcAfterOverride = await getService(API_UNIT);
  log(
    '5-api-redeploy-only',
    apiOverrideDep.done.status === 'SUCCESS' &&
      webDepCountAfter === webDepCountBefore &&
      webRevAfterApiOnly === webRevBeforeApiOnly,
    `apiDep=${apiOverrideDep.done.status} webDepCount=${webDepCountBefore}->${webDepCountAfter} webRev=${webRevBeforeApiOnly}->${webRevAfterApiOnly} apiRunning=${apiSvcAfterOverride?.status}`,
  );

  // Step 6: Project A -> C
  const revBeforeProjectChange = await getRevisions();
  await api(`/projects/${PROJECT_ID}/config/SENTRY_DSN`, {
    method: 'PUT',
    token,
    body: { value: SENTRY_C },
  });
  const revAfterProjectChange = await getRevisions();
  const webCfg3 = await unitConfig(token, WEB_UNIT);
  const apiCfg3 = await unitConfig(token, API_UNIT);
  const webS3 = reqByKey(webCfg3, 'SENTRY_DSN');
  const apiS3 = reqByKey(apiCfg3, 'SENTRY_DSN');
  log(
    '6-project-change-c',
    revAfterProjectChange.webRev > revBeforeProjectChange.webRev &&
      webS3?.needsRedeploy === true &&
      revAfterProjectChange.apiRev === revBeforeProjectChange.apiRev &&
      apiS3?.needsRedeploy === false,
    `webRev ${revBeforeProjectChange.webRev}->${revAfterProjectChange.webRev} pending=${webS3?.needsRedeploy}; apiRev ${revBeforeProjectChange.apiRev}->${revAfterProjectChange.apiRev} pending=${apiS3?.needsRedeploy}; sharedRev=${revAfterProjectChange.sharedRev}`,
  );

  // Step 7: Redeploy Web only
  const apiRevBeforeWebOnly = (await getRevisions()).apiRev;
  const apiDepCountBeforeWeb = await countUnitDeployments(API_UNIT);
  const webRedeploy = await deployUnit(token, WEB_UNIT);
  const apiDepCountAfterWeb = await countUnitDeployments(API_UNIT);
  const apiRevAfterWebOnly = (await getRevisions()).apiRev;
  log(
    '7-web-only-redeploy',
    webRedeploy.done.status === 'SUCCESS' &&
      apiDepCountAfterWeb === apiDepCountBeforeWeb &&
      apiRevAfterWebOnly === apiRevBeforeWebOnly,
    `webDep=${webRedeploy.done.status} apiDepCount=${apiDepCountBeforeWeb}->${apiDepCountAfterWeb} apiRev=${apiRevBeforeWebOnly}->${apiRevAfterWebOnly}`,
  );

  // Step 8: Restore API shared
  const revBeforeRestore = await getRevisions();
  await api(
    `/projects/${PROJECT_ID}/units/${API_UNIT}/config/SENTRY_DSN/restore-shared`,
    { method: 'POST', token },
  );
  const revAfterRestore = await getRevisions();
  const apiCfg4 = await unitConfig(token, API_UNIT);
  const webCfg4 = await unitConfig(token, WEB_UNIT);
  const apiS4 = reqByKey(apiCfg4, 'SENTRY_DSN');
  const webS4 = reqByKey(webCfg4, 'SENTRY_DSN');
  log(
    '8-restore-shared',
    apiS4?.resolvedSource === 'PROJECT' &&
      apiS4?.hasUnitOverride === false &&
      apiS4?.needsRedeploy === true &&
      revAfterRestore.apiRev > revBeforeRestore.apiRev &&
      revAfterRestore.webRev === revBeforeRestore.webRev &&
      webS4?.resolvedSource === 'PROJECT',
    `api=${apiS4?.resolvedSource} pending=${apiS4?.needsRedeploy}; rev api ${revBeforeRestore.apiRev}->${revAfterRestore.apiRev}`,
  );

  // Step 9: Redeploy API
  const apiRestoreDep = await deployUnit(token, API_UNIT);
  const cfgCheck2 = await fetch('https://api-launchos.zsaos.com/config-check').then((r) => r.json());
  const apiCfgApplied2 = await unitConfig(token, API_UNIT);
  const apiSApplied2 = reqByKey(apiCfgApplied2, 'SENTRY_DSN');
  log(
    '9-api-redeploy-restored',
    apiRestoreDep.done.status === 'SUCCESS' &&
      cfgCheck2.sentryConfigured === true &&
      apiSApplied2?.applyStatus === 'applied',
    `dep=${apiRestoreDep.done.status} sentryConfigured=${cfgCheck2.sentryConfigured} apply=${apiSApplied2?.applyStatus}`,
  );

  // Step 10: DATABASE_URL project shared (ensure no unit override)
  try {
    await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/DATABASE_URL`, {
      method: 'DELETE',
      token,
    });
  } catch {
    // ignore if absent
  }
  await api(`/projects/${PROJECT_ID}/config/DATABASE_URL`, {
    method: 'PUT',
    token,
    body: { value: DB_URL },
  });
  const webCfgDb = await unitConfig(token, WEB_UNIT);
  const apiCfgDb = await unitConfig(token, API_UNIT);
  const webDb = reqByKey(webCfgDb, 'DATABASE_URL');
  const apiDb = reqByKey(apiCfgDb, 'DATABASE_URL');
  log(
    '10-database-isolation',
    !webDb && apiDb?.resolvedSource === 'PROJECT' && apiDb?.effectiveConfigured === true,
    `webHasDbReq=${Boolean(webDb)} apiSource=${apiDb?.resolvedSource} apiConfigured=${apiDb?.effectiveConfigured}`,
  );

  // Resolver keys for web (internal API via prisma + deployment resolver)
  const { RuntimeConfigResolver } = require(resolve(ROOT, 'packages/deployment/dist/index.js'));
  const prisma = new PrismaClient();
  const resolver = new RuntimeConfigResolver(prisma);
  const webBuild = await resolver.resolve({
    projectId: PROJECT_ID,
    deployableUnitId: WEB_UNIT,
    phase: 'BUILD',
  });
  const webRuntime = await resolver.resolve({
    projectId: PROJECT_ID,
    deployableUnitId: WEB_UNIT,
    phase: 'RUNTIME',
  });
  await prisma.$disconnect();
  log(
    '10-web-resolver-no-db',
    !webBuild.keys.includes('DATABASE_URL') && !webRuntime.keys.includes('DATABASE_URL'),
    `buildKeys=${webBuild.keys.join(',')} runtimeKeys=${webRuntime.keys.join(',')}`,
  );

  // Step 11: Deploy API for database
  const webDepCountBeforeDb = await countUnitDeployments(WEB_UNIT);
  const dbDep = await deployUnit(token, API_UNIT);
  const cfgCheckDb = await fetch('https://api-launchos.zsaos.com/config-check').then((r) => r.json());
  const webDepCountAfterDb = await countUnitDeployments(WEB_UNIT);
  log(
    '11-api-db-deploy',
    dbDep.done.status === 'SUCCESS' &&
      cfgCheckDb.databaseConfigured === true &&
      webDepCountAfterDb === webDepCountBeforeDb,
    `dep=${dbDep.done.status} databaseConfigured=${cfgCheckDb.databaseConfigured} webDepCount=${webDepCountBeforeDb}->${webDepCountAfterDb}`,
  );

  // Step 12: Delete project DATABASE_URL
  const revBeforeDbDelete = await getRevisions();
  await api(`/projects/${PROJECT_ID}/config/DATABASE_URL`, {
    method: 'DELETE',
    token,
  });
  const apiCfgMissing = await unitConfig(token, API_UNIT);
  const webCfgUnchanged = await unitConfig(token, WEB_UNIT);
  const apiDbMissing = reqByKey(apiCfgMissing, 'DATABASE_URL');
  const revAfterDbDelete = await getRevisions();
  const apiSvcStillRunning = await getService(API_UNIT);
  const webSvcStillRunning = await getService(WEB_UNIT);
  log(
    '12-delete-db-still-running',
    apiDbMissing?.missing === true &&
      apiDbMissing?.resolvedSource === 'MISSING' &&
      apiSvcStillRunning?.status === 'RUNNING' &&
      revAfterDbDelete.webRev === revBeforeDbDelete.webRev &&
      !reqByKey(webCfgUnchanged, 'DATABASE_URL'),
    `apiMissing=${apiDbMissing?.missing} apiStatus=${apiSvcStillRunning?.status} webRevSame=${revAfterDbDelete.webRev === revBeforeDbDelete.webRev}`,
  );

  // Block deploy API
  let blocked = false;
  let blockMsg = '';
  try {
    await api(`/projects/${PROJECT_ID}/deployments`, {
      method: 'POST',
      token,
      body: {
        environmentId: ENV_ID,
        hostingMode: 'my-server',
        serverInstanceId: SERVER_ID,
        deployableUnitId: API_UNIT,
      },
    });
  } catch (err) {
    blocked = err.status === 400;
    blockMsg = err.body?.message || err.message;
  }
  log(
    '12-api-deploy-blocked',
    blocked && /运行配置|数据库/.test(blockMsg),
    `blocked=${blocked} msg=${blockMsg.slice(0, 80)}`,
  );

  // Web HTTPS still ok
  let webHttps = 0;
  try {
    const r = await fetch('https://web-launchos.zsaos.com/', { signal: AbortSignal.timeout(20000) });
    webHttps = r.status;
  } catch {
    webHttps = 0;
  }
  log(
    '13-web-unaffected',
    webHttps === 200 &&
      webSvcStillRunning?.status === 'RUNNING' &&
      revAfterDbDelete.webRev === revBeforeDbDelete.webRev,
    `https=${webHttps} webStatus=${webSvcStillRunning?.status}`,
  );

  // Step 14: Restore DATABASE_URL
  await api(`/projects/${PROJECT_ID}/config/DATABASE_URL`, {
    method: 'PUT',
    token,
    body: { value: DB_URL },
  });
  const apiCfgRestored = await unitConfig(token, API_UNIT);
  const apiDbRestored = reqByKey(apiCfgRestored, 'DATABASE_URL');
  log(
    '14-restore-db',
    apiDbRestored?.resolvedSource === 'PROJECT' && apiDbRestored?.effectiveConfigured === true,
    `source=${apiDbRestored?.resolvedSource} configured=${apiDbRestored?.effectiveConfigured}`,
  );

  // Security checks
  const logHits = await scanLogsForSecrets();
  log('15-log-secret-hits', logHits === 0, `hits=${logHits}`);

  const prisma2 = new PrismaClient();
  const versions = await prisma2.applicationVersion.findMany({
    where: { projectId: PROJECT_ID },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { configKeys: true, configFingerprint: true, configRevision: true },
  });
  await prisma2.$disconnect();
  const versionHits = versions.filter((v) => {
    const blob = JSON.stringify(v);
    return FORBIDDEN.some((n) => n.length > 12 && blob.includes(n));
  }).length;
  log('15-version-no-secrets', versionHits === 0, `hits=${versionHits}`);

  const remote = await checkRemoteEnvFiles();
  if (!remote.skipped) {
    log('15-remote-env-cleanup', remote.remaining === 0, `remaining=${remote.remaining}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ total: results.length, failed: failed.length, failedSteps: failed.map((f) => f.step) }, null, 2));
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E_FATAL', err.message);
  process.exit(1);
});
