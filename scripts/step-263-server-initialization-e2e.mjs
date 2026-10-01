/**
 * Step 26.3 Server Initialization E2E
 *
 * Dry-run (default — read-only, no enqueue / no SSH write):
 *   node scripts/step-263-server-initialization-e2e.mjs --server-instance-id=cmub78pz001sdripco5pexhdz
 *
 * Real init (Phase 2 — requires explicit confirm + whitelist gates):
 *   node scripts/step-263-server-initialization-e2e.mjs `
 *     --confirm-initialize `
 *     --server-instance-id=cmub78pz001sdripco5pexhdz
 *
 * Never process.exit() on Windows (undici keep-alive).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

/** Step 26.3 real E2E whitelist — only this target may receive write ops. */
const TARGET_SI = 'cmub78pz001sdripco5pexhdz';
const TARGET_PROVIDER = 'i-bp18fpmcju7ntitybcm8';
const TARGET_IP = '116.62.198.184';
const OLD_IP = '8.138.113.134';

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';

/** Same base as Step 26.2 — do not double-prefix /api/v1. */
function apiUrl(path) {
  const base = API.replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

function parseArgv(argv) {
  let serverInstanceId = null;
  let confirmInitialize = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--confirm-initialize') confirmInitialize = true;
    else if (a.startsWith('--server-instance-id=')) {
      serverInstanceId = a.slice('--server-instance-id='.length);
    } else if (a === '--server-instance-id') {
      serverInstanceId = argv[i + 1] || null;
      i += 1;
    }
  }
  return { serverInstanceId, confirmInitialize };
}

const { serverInstanceId: CLI_SI, confirmInitialize: CONFIRM } = parseArgv(process.argv);
const SERVER_INSTANCE_ID = CLI_SI || TARGET_SI;

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const {
  buildServerInitializationPlan,
  buildRuntimeDetectionSummary,
  buildRuntimePlanFromFacts,
  canStartServerInitialization,
  decideRuntimeInstallStrategy,
  decryptCredential,
  emptyTool,
  isEncryptedCredential,
  parseOsReleaseFields,
  resolveOsPackageFamily,
  resolveServerSshUsername,
  resumeFromPhase,
  serverInitializationJobId,
  serverInitializationLockKey,
  shellCommand,
  toolFromCommandProbe,
  tryAcquireRedisLock,
  DYNAMIC_PORT_RANGE_START,
  DYNAMIC_PORT_RANGE_END,
  RUNTIME_BIND_ADDRESS,
} = require('@launchos/shared');
const { RemoteRunner } = require('@launchos/remote-runner');

async function softExec(runner, command) {
  try {
    const r = await runner.execute(command, { timeoutMs: 20_000 });
    return { exitCode: r.exitCode, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function detectBinary(runner, name) {
  const pathProbe = await softExec(
    runner,
    shellCommand(`command -v ${name} 2>/dev/null || true`),
  );
  const path = pathProbe.stdout.split(/\s+/)[0] || '';
  if (!path) return emptyTool();
  const ver = await softExec(
    runner,
    shellCommand(`${name} --version 2>/dev/null | head -n 1 || true`),
  );
  return toolFromCommandProbe({
    pathStdout: path,
    pathExitCode: 0,
    versionStdout: ver.stdout,
    versionExitCode: ver.exitCode,
  });
}

/**
 * Read-only host fact refresh for dry-run observability.
 * Never installs / never mutates firewall.
 */
async function probeRuntimeFactsReadonly(server) {
  const password = decryptCredential(server.credentialEncrypted);
  const username = resolveServerSshUsername({
    serverUsername: server.username,
    provider: server.provider,
  });
  const runner = new RemoteRunner();
  try {
    await runner.connect({
      host: server.host,
      port: server.port || 22,
      username,
      password,
      readyTimeoutMs: 25_000,
    });
    const osRel = await softExec(runner, shellCommand('cat /etc/os-release'));
    const fields = parseOsReleaseFields(osRel.stdout);
    const packageFamily = resolveOsPackageFamily(fields);
    const tools = {
      podman: await detectBinary(runner, 'podman'),
      docker: await detectBinary(runner, 'docker'),
      dnf: await detectBinary(runner, 'dnf'),
      yum: await detectBinary(runner, 'yum'),
      microdnf: await detectBinary(runner, 'microdnf'),
      rpm: await detectBinary(runner, 'rpm'),
      aptGet: await detectBinary(runner, 'apt-get'),
    };
    const root = await softExec(
      runner,
      shellCommand('test -d /opt/launchos && echo yes || echo no'),
    );
    await runner.disconnect();
    const strategy = decideRuntimeInstallStrategy({ tools, osFamily: packageFamily });
    return {
      osName: fields.osName,
      osVersion: fields.osVersion,
      packageFamily,
      tools,
      strategy,
      launchosRootExists: root.stdout === 'yes',
      passwordLength: password.length,
    };
  } catch (error) {
    try {
      await runner.disconnect();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function assertNoSecret(blob, label) {
  const text = typeof blob === 'string' ? blob : JSON.stringify(blob);
  if (/AccessKeyId":\s*"LTAI|accessKeySecret|BEGIN (RSA |OPENSSH )?PRIVATE KEY/i.test(text)) {
    throw new Error(`secret leak in ${label}`);
  }
  if (/"password"\s*:\s*"[^"*]{8,}"/i.test(text)) throw new Error(`password leak in ${label}`);
  if (process.env.__STEP263_PLAIN_PASSWORD && text.includes(process.env.__STEP263_PLAIN_PASSWORD)) {
    throw new Error(`plaintext password leak in ${label}`);
  }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(apiUrl(path), { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(
      Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText,
    );
    err.payload = json;
    throw err;
  }
  assertNoSecret(json, path);
  return json;
}

async function closeFetchDispatcher() {
  try {
    const undici = await import('undici');
    const dispatcher = undici.getGlobalDispatcher?.();
    if (dispatcher && typeof dispatcher.close === 'function') {
      await dispatcher.close();
    }
  } catch {
    // ignore
  }
}

/**
 * Side-effect-free route probe (GET initialization).
 * Distinguishes API down vs route missing (Cannot GET …).
 */
async function probeInitializationEndpoint(token) {
  const path = `/projects/${PROJECT_ID}/server/initialization`;
  const url = apiUrl(path);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const text = await res.text();
    if (res.status === 404 && /Cannot GET/i.test(text)) {
      return {
        apiReachable: true,
        initializationEndpointReady: false,
        httpStatus: 404,
        probeUrl: url,
        detail: 'route missing',
      };
    }
    // 401 without token is still "route exists"
    if (!token && (res.status === 401 || res.status === 403)) {
      return {
        apiReachable: true,
        initializationEndpointReady: true,
        httpStatus: res.status,
        probeUrl: url,
        detail: 'auth required (route present)',
      };
    }
    if (res.ok || res.status === 401 || res.status === 403 || res.status === 404) {
      // 404 JSON from Nest NotFoundException still means route matched
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const expressMiss = typeof text === 'string' && /Cannot GET/i.test(text);
      return {
        apiReachable: true,
        initializationEndpointReady: !expressMiss,
        httpStatus: res.status,
        probeUrl: url,
        found: json?.found,
        detail: expressMiss ? 'route missing' : 'ok',
      };
    }
    return {
      apiReachable: true,
      initializationEndpointReady: res.status !== 404,
      httpStatus: res.status,
      probeUrl: url,
      detail: text.slice(0, 120),
    };
  } catch (error) {
    return {
      apiReachable: false,
      initializationEndpointReady: false,
      httpStatus: null,
      probeUrl: url,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function printRealInitializationGate(gate) {
  console.log('\nREAL_INITIALIZATION_GATE:');
  console.log(JSON.stringify(gate, null, 2));
  assertNoSecret(gate, 'REAL_INITIALIZATION_GATE');
}

/**
 * Evaluate all Phase 2 pre-write gates. Mutates blockers.
 */
function evaluateWhitelistAndReadiness({
  serverInstanceId,
  providerResourceId,
  publicIp,
  serverReadiness,
  credentialReady,
  sshCredentialMode,
  passwordPresent,
  initializationQueueReady,
  lockReady,
  blockers,
}) {
  if (serverInstanceId !== TARGET_SI) {
    blockers.push(`serverInstanceId whitelist: must be ${TARGET_SI}`);
  }
  if (!providerResourceId) blockers.push('providerResourceId missing');
  else if (providerResourceId !== TARGET_PROVIDER) {
    blockers.push(`providerResourceId whitelist: must be ${TARGET_PROVIDER}`);
  }
  if (!publicIp) blockers.push('publicIp missing');
  else if (publicIp !== TARGET_IP) {
    blockers.push(`publicIp whitelist: must be ${TARGET_IP}`);
  }
  if (publicIp === OLD_IP) blockers.push('old server targeted (8.138.113.134)');
  if (!credentialReady) blockers.push('credentialReady=false');
  if (sshCredentialMode !== 'PASSWORD_V1_FALLBACK') {
    blockers.push(`sshCredentialMode must be PASSWORD_V1_FALLBACK, got ${sshCredentialMode}`);
  }
  if (!passwordPresent) blockers.push('passwordPresent=false');
  if (
    serverReadiness !== 'READY_FOR_INITIALIZATION' &&
    serverReadiness !== 'INITIALIZATION_FAILED' &&
    serverReadiness !== 'READY'
  ) {
    blockers.push(`serverReadiness=${serverReadiness} not allowed`);
  }
  if (
    serverReadiness !== 'READY' &&
    !canStartServerInitialization(serverReadiness)
  ) {
    blockers.push(`serverReadiness=${serverReadiness} not startable`);
  }
  if (!initializationQueueReady) blockers.push('initializationQueue not ready');
  if (!lockReady) blockers.push('lock not ready');

  const oldServerUntouched = publicIp !== OLD_IP && TARGET_IP !== OLD_IP;
  if (!oldServerUntouched) blockers.push('oldServerUntouched=false');

  const canInitialize =
    blockers.length === 0 &&
    (canStartServerInitialization(serverReadiness) || serverReadiness === 'READY');

  return { oldServerUntouched, canInitialize };
}

async function main() {
  const prisma = new PrismaClient();
  const blockers = [];
  let writeCommandsExecuted = false;
  let credentialReady = false;
  let passwordLength = 0;
  let sshCredentialMode = 'UNKNOWN';
  let initializationQueueReady = false;
  let lockReady = false;

  try {
    const server = await prisma.serverInstance.findUnique({
      where: { id: SERVER_INSTANCE_ID },
    });
    if (!server) {
      blockers.push('serverInstance not found');
      console.log(JSON.stringify({ error: 'not found', serverInstanceId: SERVER_INSTANCE_ID }, null, 2));
      return;
    }

    const resources = await prisma.cloudResource.findMany({
      where: { workspaceId: server.workspaceId },
      orderBy: { updatedAt: 'desc' },
      take: 40,
    });
    const linked =
      resources.find((r) => {
        const m =
          r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
            ? r.metadata
            : {};
        return m.serverInstanceId === server.id;
      }) ||
      resources.find((r) => r.publicIp === server.host) ||
      null;

    const crMeta =
      linked?.metadata && typeof linked.metadata === 'object' && !Array.isArray(linked.metadata)
        ? linked.metadata
        : {};
    const providerResourceId = linked?.providerResourceId || null;
    const privateIp =
      (typeof crMeta.privateIp === 'string' && crMeta.privateIp) ||
      (typeof crMeta.PrivateIpAddress === 'string' && crMeta.PrivateIpAddress) ||
      null;
    const publicIp = server.host;
    const imageName =
      (typeof crMeta.imageId === 'string' && crMeta.imageId) ||
      (typeof crMeta.imageName === 'string' && crMeta.imageName) ||
      null;

    const enc = server.credentialEncrypted || '';
    if (enc && isEncryptedCredential(enc)) {
      try {
        const plain = decryptCredential(enc);
        credentialReady = plain.length > 0;
        passwordLength = plain.length;
        sshCredentialMode = 'PASSWORD_V1_FALLBACK';
        process.env.__STEP263_PLAIN_PASSWORD = plain;
      } catch {
        blockers.push('credential decrypt failed');
      }
    } else {
      blockers.push('credential missing or not encrypted');
    }

    const username = resolveServerSshUsername({
      serverUsername: server.username,
      imageName,
      provider: server.provider,
    });

    const serverMeta =
      server.metadata && typeof server.metadata === 'object' && !Array.isArray(server.metadata)
        ? server.metadata
        : {};
    const lastSuccessfulPhase = serverMeta.lastSuccessfulPhase || null;
    const resumeFrom = resumeFromPhase(lastSuccessfulPhase);

    // Read-only runtime detection (no install)
    let runtimeFacts = null;
    try {
      runtimeFacts = await probeRuntimeFactsReadonly(server);
    } catch (error) {
      blockers.push(
        `runtimeDetectionFailed=${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
      );
    }

    const strategy = runtimeFacts?.strategy || { kind: 'UNSUPPORTED_PACKAGE_MANAGER' };
    const tools = runtimeFacts?.tools || {
      podman: emptyTool(),
      docker: emptyTool(),
      dnf: emptyTool(),
      yum: emptyTool(),
      microdnf: emptyTool(),
      rpm: emptyTool(),
      aptGet: emptyTool(),
    };
    const packageFamily = runtimeFacts?.packageFamily || 'unknown';
    const runtimeDetection = buildRuntimeDetectionSummary(tools);
    const runtimePlan = buildRuntimePlanFromFacts({
      packageFamily,
      tools,
      strategy,
    });
    const selectedPackageManager =
      strategy.kind === 'INSTALL' ? strategy.packageManager : null;
    const selectedRuntimeStrategy = strategy.kind;
    const canResume =
      canStartServerInitialization(server.status) &&
      selectedRuntimeStrategy !== 'UNSUPPORTED_PACKAGE_MANAGER' &&
      selectedRuntimeStrategy !== 'PACKAGE_MANAGER_PROBE_FAILED';

    const plan = buildServerInitializationPlan({
      publicIp,
      privateIp,
      providerResourceId,
      username,
      passwordPresent: credentialReady,
      runtimePlan,
    });

    // Queue readiness via Redis ping
    let redisReady = false;
    let serverInitializationQueueReady = false;
    let existingJobState = null;
    let workerConsumerReady = false;
    let workerOnline = false;
    try {
      const Redis = require('ioredis');
      const { Queue } = require('bullmq');
      const {
        SERVER_INITIALIZATION_QUEUE,
        DEPLOYMENT_WORKER_SERVICE,
        WORKER_ONLINE_THRESHOLD_MS,
      } = require('@launchos/shared');
      const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
      const connection = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      });
      await connection.connect();
      const pong = await connection.ping();
      redisReady = String(pong).toUpperCase() === 'PONG';
      const q = new Queue(SERVER_INITIALIZATION_QUEUE, { connection });
      try {
        const paused = await q.isPaused();
        await q.getJobCounts('waiting', 'active', 'delayed');
        const job = await q.getJob(serverInitializationJobId(server.id));
        existingJobState = job ? await job.getState() : null;
        serverInitializationQueueReady = redisReady && !paused;
        initializationQueueReady = serverInitializationQueueReady;
      } finally {
        await q.close().catch(() => undefined);
        await connection.quit().catch(() => undefined);
      }

      // Worker consumer readiness from heartbeat meta (no enqueue)
      const hb = await prisma.workerHeartbeat.findFirst({
        where: { service: DEPLOYMENT_WORKER_SERVICE },
        orderBy: { lastSeenAt: 'desc' },
      });
      if (hb) {
        const ageMs = Date.now() - hb.lastSeenAt.getTime();
        workerOnline = hb.status !== 'OFFLINE' && ageMs <= WORKER_ONLINE_THRESHOLD_MS;
        const meta =
          hb.meta && typeof hb.meta === 'object' && !Array.isArray(hb.meta) ? hb.meta : {};
        workerConsumerReady = Boolean(meta.queueReady?.serverInitialization);
      }
    } catch {
      blockers.push('redis/queue not reachable');
      initializationQueueReady = false;
      redisReady = false;
      serverInitializationQueueReady = false;
    }
    if (!redisReady) blockers.push('redisReady=false');
    if (!serverInitializationQueueReady) {
      blockers.push('serverInitializationQueueReady=false');
    }
    if (!workerOnline) blockers.push('workerOnline=false');
    if (!workerConsumerReady) {
      blockers.push('workerConsumerReady=false');
    }

    try {
      const handle = await tryAcquireRedisLock(
        `probe-${serverInitializationLockKey(server.id)}`,
        3_000,
      );
      if (handle) {
        lockReady = true;
        await handle.release();
      } else {
        lockReady = true;
      }
    } catch {
      blockers.push('lock capability failed');
      lockReady = false;
    }

    const failedJobResumeSafe =
      existingJobState === 'failed' ||
      existingJobState === 'completed' ||
      existingJobState === null;
    // failed BullMQ job must not block resume (enqueue removes+readds same jobId)
    if (existingJobState === 'waiting' || existingJobState === 'active' || existingJobState === 'delayed') {
      // in-flight is handled as alreadyInProgress at API layer; dry-run just reports
    }

    // Route readiness (no write) — login optional for 401-as-present check
    let routeProbe = await probeInitializationEndpoint(null);
    if (!routeProbe.initializationEndpointReady) {
      // retry with token so authenticated 200/404 JSON still counts as ready
      try {
        const login = await api('/auth/login', {
          method: 'POST',
          body: {
            email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
            password: process.env.E2E_PASSWORD || 'Launchos123!',
          },
        });
        routeProbe = await probeInitializationEndpoint(login.accessToken);
      } catch {
        // keep unauthenticated probe result
      }
    }
    if (!routeProbe.apiReachable) {
      blockers.push('API unreachable');
    }
    if (!routeProbe.initializationEndpointReady) {
      blockers.push('INITIALIZATION_API_ROUTE_UNAVAILABLE');
    }

    const { oldServerUntouched, canInitialize } = evaluateWhitelistAndReadiness({
      serverInstanceId: server.id,
      providerResourceId,
      publicIp,
      serverReadiness: server.status,
      credentialReady,
      sshCredentialMode,
      passwordPresent: credentialReady,
      initializationQueueReady,
      lockReady,
      blockers,
    });

    const realGate = {
      targetServerInstanceId: server.id,
      providerResourceId,
      publicIp,
      privateIp,
      serverReadiness: server.status,
      credentialReady,
      sshCredentialMode,
      sshUsername: username,
      passwordPresent: credentialReady,
      redisReady,
      queueReady: initializationQueueReady,
      serverInitializationQueueReady,
      existingJobState,
      failedJobResumeSafe,
      workerOnline,
      workerConsumerReady,
      lockReady,
      apiReachable: routeProbe.apiReachable,
      initializationEndpointReady: routeProbe.initializationEndpointReady,
      initializationProbeUrl: routeProbe.probeUrl,
      runtimeDetection,
      selectedPackageManager,
      selectedRuntimeStrategy,
      lastSuccessfulPhase,
      resumeFromPhase: resumeFrom,
      canResume,
      oldServerUntouched,
      canInitialize,
      blockers: [...blockers],
      phase2ConfirmPathEnabled: true,
      confirmInitializeRequested: CONFIRM,
      API_BASE: API,
      nestPostRoute: '/api/v1/projects/:projectId/server/initialize',
    };

    printRealInitializationGate(realGate);

    const report = {
      step: '26.3',
      phase: '2',
      mode: CONFIRM ? 'CONFIRM_INITIALIZE' : 'DRY_RUN',
      serverInstanceId: server.id,
      providerResourceId,
      publicIp,
      privateIp,
      serverReadiness: server.status,
      credentialReady,
      sshCredentialMode,
      sshUsername: username,
      passwordPresent: credentialReady,
      passwordLength,
      initializationQueueReady,
      redisReady,
      serverInitializationQueueReady,
      existingJobState,
      failedJobResumeSafe,
      workerOnline,
      workerConsumerReady,
      lockReady,
      apiReachable: routeProbe.apiReachable,
      initializationEndpointReady: routeProbe.initializationEndpointReady,
      jobId: serverInitializationJobId(server.id),
      lockKey: serverInitializationLockKey(server.id),
      API_BASE: API,
      nestPostRoute: '/api/v1/projects/:projectId/server/initialize',
      osName: runtimeFacts?.osName || serverMeta.osName || null,
      osVersion: runtimeFacts?.osVersion || serverMeta.osVersion || null,
      packageFamily,
      runtimeDetection,
      selectedPackageManager,
      selectedRuntimeStrategy,
      lastSuccessfulPhase,
      resumeFromPhase: resumeFrom,
      canResume,
      launchosRootExists: runtimeFacts?.launchosRootExists ?? null,
      osDetectionPlan: plan.osDetectionPlan,
      directoryPlan: plan.directoryPlan,
      runtimePlan: plan.runtimePlan,
      firewallPlan: plan.firewallPlan,
      runtimeConfigPlan: plan.runtimeConfigPlan,
      dynamicPortRangeStart: DYNAMIC_PORT_RANGE_START,
      dynamicPortRangeEnd: DYNAMIC_PORT_RANGE_END,
      bindAddress: RUNTIME_BIND_ADDRESS,
      oldServerUntouched,
      canInitialize,
      blockers,
      WRITE_COMMANDS_EXECUTED: writeCommandsExecuted,
      WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
      sshReachable: runtimeFacts ? true : 'skipped_until_confirm',
      osDetected: Boolean(runtimeFacts?.osName),
      note: CONFIRM
        ? 'Phase 2: will enqueue after gate pass'
        : 'dry-run: read-only fact probe only; no enqueue / no install',
    };

    assertNoSecret(report, 'report');

    console.log('\n=== Step 26.3 Server Initialization ===');
    console.log(JSON.stringify(report, null, 2));

    // —— Dry-run path: stop here ——
    if (!CONFIRM) {
      console.log('\nDRY_RUN complete. WRITE_COMMANDS_EXECUTED=false');
      console.log('oldServerUntouched=' + oldServerUntouched);
      delete process.env.__STEP263_PLAIN_PASSWORD;
      return;
    }

    // —— Real confirm path (Phase 2) ——
    if (!canInitialize || blockers.length > 0) {
      console.log('\nREFUSED: real initialization blocked by gate.');
      console.log('WRITE_COMMANDS_EXECUTED=false');
      delete process.env.__STEP263_PLAIN_PASSWORD;
      return;
    }

    if (server.status === 'READY') {
      console.log('\nalreadyReady=true — skip enqueue. WRITE_COMMANDS_EXECUTED=false');
      delete process.env.__STEP263_PLAIN_PASSWORD;
      return;
    }

    // Re-print gate immediately before first write (enqueue)
    printRealInitializationGate({
      ...realGate,
      stage: 'pre_enqueue',
      WRITE_COMMANDS_EXECUTED: false,
    });

    const login = await api('/auth/login', {
      method: 'POST',
      body: {
        email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
        password: process.env.E2E_PASSWORD || 'Launchos123!',
      },
    });
    const token = login.accessToken;

    console.log('\nPOST /server/initialize …');
    const started = await api(`/projects/${PROJECT_ID}/server/initialize`, {
      method: 'POST',
      token,
      body: { serverInstanceId: server.id },
    });
    assertNoSecret(started, 'initialize response');

    // First real write submitted to control plane (enqueue) — worker will SSH-write next
    writeCommandsExecuted = true;
    console.log('WRITE_COMMANDS_EXECUTED=true (initialize enqueued)');
    console.log(
      JSON.stringify(
        {
          alreadyReady: started.alreadyReady || false,
          alreadyInProgress: started.alreadyInProgress || false,
          jobId: started.jobId || serverInitializationJobId(server.id),
          serverReadiness: started.serverReadiness,
          phase: started.phase,
        },
        null,
        2,
      ),
    );

    if (started.alreadyReady) {
      console.log('alreadyReady — no new worker chain');
      delete process.env.__STEP263_PLAIN_PASSWORD;
      return;
    }

    // Poll until READY / INITIALIZATION_FAILED
    let finalStatus = null;
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      finalStatus = await api(
        `/projects/${PROJECT_ID}/server/initialization/${server.id}`,
        { token },
      );
      assertNoSecret(finalStatus, 'initialization status');
      console.log(
        `poll#${i + 1} readiness=${finalStatus.serverReadiness} phase=${finalStatus.phase} progress=${finalStatus.progress ?? '?'}`,
      );
      if (
        finalStatus.serverReadiness === 'READY' ||
        finalStatus.serverReadiness === 'INITIALIZATION_FAILED'
      ) {
        break;
      }
    }

    console.log('\n=== FINAL STATUS ===');
    console.log(
      JSON.stringify(
        {
          serverInstanceId: finalStatus?.serverInstanceId,
          serverReadiness: finalStatus?.serverReadiness,
          phase: finalStatus?.phase,
          osName: finalStatus?.osName,
          runtimeType: finalStatus?.runtimeType,
          runtimeVersion: finalStatus?.runtimeVersion,
          dockerCompatibility: finalStatus?.dockerCompatibility,
          firewallStatus: finalStatus?.firewallStatus,
          launchosRoot: finalStatus?.launchosRoot,
          bindAddress: finalStatus?.bindAddress,
          dynamicPortRangeStart: finalStatus?.dynamicPortRangeStart,
          dynamicPortRangeEnd: finalStatus?.dynamicPortRangeEnd,
          errorCode: finalStatus?.errorCode,
          errorMessage: finalStatus?.errorMessage,
          WRITE_COMMANDS_EXECUTED: writeCommandsExecuted,
          oldServerUntouched: true,
        },
        null,
        2,
      ),
    );

    delete process.env.__STEP263_PLAIN_PASSWORD;
  } finally {
    await prisma.$disconnect();
    await closeFetchDispatcher();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  delete process.env.__STEP263_PLAIN_PASSWORD;
});
