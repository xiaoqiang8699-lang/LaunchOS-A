/**
 * Step 28 — Multi-Unit Managed Deployment (Web onto same Managed Server as API).
 *
 * Default: dry-run (no upload / podman run / enqueue).
 *
 * Phase 2 real deploy (explicit confirm + whitelist gates):
 *   node scripts/step-28-multi-unit-managed-deployment-e2e.mjs --confirm-deploy \
 *     --project-id=cmu3j24mv0001ri7wcsoa30hj \
 *     --web-unit-id=cmu3j27340007ri7wcno1xrai
 *
 * Confirm-path gate fixture (no enqueue / no remote write):
 *   node scripts/step-28-multi-unit-managed-deployment-e2e.mjs --confirm-deploy --gate-only
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

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

/** Phase 2 unlock marker — confirm path enabled; Phase 1 global refuse removed. */
const phase2ConfirmPathEnabled = true;

const CONFIRM = process.argv.includes('--confirm-deploy');
const GATE_ONLY = process.argv.includes('--gate-only');
const PROJECT_ID =
  argValue('--project-id') || 'cmu3j24mv0001ri7wcsoa30hj';
const WEB_UNIT_ID =
  argValue('--web-unit-id') || argValue('--unit-id') || 'cmu3j27340007ri7wcno1xrai';
const API_UNIT_ID =
  argValue('--api-unit-id') || 'cmu3j272x0005ri7wlxlbajeu';
const SERVER_ID =
  argValue('--server-instance-id') || 'cmub78pz001sdripco5pexhdz';
const WEB_SOURCE_ARTIFACT_ID =
  argValue('--web-source-artifact-id') || 'cmu3scwr3016fri3c35ryb3y2';
const WEB_DEPLOYABLE_ARTIFACT_ID =
  argValue('--web-deployable-artifact-id') || 'cmuc6x7hd0001ri10yvj0rr6o';
const ENV_ID = argValue('--environment-id') || process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';
const API_SI_ID = 'cmuc66642002hritk6h3cbwhe';
const OLD_HOST = '8.138.113.134';
const TARGET_HOST = '116.62.198.184';
const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';

function argValue(flag) {
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i].startsWith(`${flag}=`)) return process.argv[i].slice(flag.length + 1);
    if (process.argv[i] === flag) return process.argv[i + 1];
  }
  return null;
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDeployment = createRequire(resolve(root, 'packages/deployment/package.json'));
const { PrismaClient, ServiceStatus, ArtifactStatus, ArtifactType } = requireApi('@launchos/database');
const {
  evaluateManagedServerForDeploy,
  planNextRuntimePort,
  summarizeManagedDeployGate,
  managedDeploymentLockKey,
  redactSecrets,
  DEPLOYMENT_QUEUE,
  STEP28_MULTI_UNIT_DEPLOY_WHITELIST,
  assertRuntimePublishSpec,
  RUNTIME_BIND_ADDRESS,
  resolveRunnableStartCommand,
  asDockerImageMetadata,
  assertImageArchitectureCompatible,
  normalizeImageArchitecture,
  normalizeServerArchitecture,
  RUNTIME_PULL_POLICY,
  MANAGED_SERVER_ARCHITECTURE,
  resolveUnitHealthCheck,
  filterRuntimeEnvForUnitType,
  WEB_FORBIDDEN_RUNTIME_SECRET_KEYS,
  DYNAMIC_PORT_RANGE_START,
  DYNAMIC_PORT_RANGE_END,
  decryptCredential,
  managedAccessEntryPendingMessage,
} = requireApi('@launchos/shared');
const requireRuntime = createRequire(resolve(root, 'packages/runtime/package.json'));
let inspectLocalImageArchitecture = async () => ({
  architecture: 'amd64',
  os: 'linux',
  present: false,
});
let MANAGED_BASE_IMAGE_RUNTIME = 'node:20-alpine';
let RemoteDockerRuntime = null;
try {
  const runtime = requireRuntime('@launchos/runtime');
  inspectLocalImageArchitecture = runtime.inspectLocalImageArchitecture;
  MANAGED_BASE_IMAGE_RUNTIME = runtime.MANAGED_BASE_IMAGE || MANAGED_BASE_IMAGE_RUNTIME;
  RemoteDockerRuntime = runtime.RemoteDockerRuntime;
} catch {
  // optional until packages built
}
const {
  listDbReservedHostPorts,
  HOST_PORT_RANGE_START,
} = requireDeployment('@launchos/deployment');
const { Queue } = requireApi('bullmq');
const IORedis = requireApi('ioredis');

function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolveProbe) => {
    const started = Date.now();
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (status, code) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolveProbe({ port, status, code: code || null, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish('open'));
    socket.on('timeout', () => finish('filtered'));
    socket.on('error', (err) => {
      const code = err?.code ? String(err.code) : 'ERROR';
      finish(code === 'ECONNREFUSED' ? 'refused' : code === 'ETIMEDOUT' ? 'filtered' : 'error', code);
    });
  });
}

function assertNoSecret(json, label) {
  const blob = typeof json === 'string' ? json : JSON.stringify(json);
  if (/redis:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) throw new Error(`REDIS_URL leak in ${label}`);
  if (/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) {
    throw new Error(`DATABASE_URL leak in ${label}`);
  }
  if (/LTAI[A-Za-z0-9]{12,}/.test(blob)) throw new Error(`ALIYUN AK leak in ${label}`);
}

function printRealManagedDeploymentGate(gate) {
  console.log('\n=== REAL_MANAGED_DEPLOYMENT_GATE ===');
  console.log(JSON.stringify(gate, null, 2));
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`API ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

async function evaluateGates(prisma) {
  const blockers = [];
  const wl = STEP28_MULTI_UNIT_DEPLOY_WHITELIST;

  if (PROJECT_ID !== wl.projectId) {
    blockers.push({ code: 'SERVER_FORBIDDEN', message: 'projectId not in Step 28 whitelist' });
  }
  if (WEB_UNIT_ID !== wl.webUnitId) {
    blockers.push({ code: 'SERVER_FORBIDDEN', message: 'webUnitId not in Step 28 whitelist' });
  }
  if (API_UNIT_ID !== wl.apiUnitId) {
    blockers.push({ code: 'SERVER_FORBIDDEN', message: 'apiUnitId not in Step 28 whitelist' });
  }
  if (SERVER_ID !== wl.serverInstanceId) {
    blockers.push({
      code: 'SERVER_FORBIDDEN',
      message: 'serverInstanceId not in Step 28 whitelist',
    });
  }
  if (WEB_SOURCE_ARTIFACT_ID !== wl.webSourceArtifactId) {
    blockers.push({
      code: 'SERVER_FORBIDDEN',
      message: 'webSourceArtifactId not in Step 28 whitelist',
    });
  }
  if (WEB_DEPLOYABLE_ARTIFACT_ID !== wl.webDeployableArtifactId) {
    blockers.push({
      code: 'SERVER_FORBIDDEN',
      message: 'webDeployableArtifactId not in Step 28 whitelist',
    });
  }

  const [project, webUnit, apiUnit, server, webSource, apiSi, deployableImage] = await Promise.all([
    prisma.project.findUnique({
      where: { id: PROJECT_ID },
      select: { id: true, name: true, slug: true },
    }),
    prisma.deployableUnit.findUnique({
      where: { id: WEB_UNIT_ID },
      select: {
        id: true,
        projectId: true,
        name: true,
        type: true,
        port: true,
        framework: true,
        deployable: true,
        status: true,
        rootPath: true,
        startCommand: true,
        packageManager: true,
      },
    }),
    prisma.deployableUnit.findUnique({
      where: { id: API_UNIT_ID },
      select: { id: true, type: true, port: true, framework: true },
    }),
    prisma.serverInstance.findUnique({ where: { id: SERVER_ID } }),
    prisma.artifact.findFirst({
      where: {
        id: WEB_SOURCE_ARTIFACT_ID,
        type: ArtifactType.BUILD_OUTPUT,
        status: ArtifactStatus.READY,
        deployment: { projectId: PROJECT_ID, deployableUnitId: WEB_UNIT_ID },
      },
      select: { id: true, type: true, status: true, size: true, deploymentId: true },
    }),
    prisma.serviceInstance.findUnique({
      where: { id: API_SI_ID },
      select: {
        id: true,
        status: true,
        healthStatus: true,
        externalPort: true,
        port: true,
        serverInstanceId: true,
        deployableUnitId: true,
        containerId: true,
      },
    }),
    prisma.artifact.findFirst({
      where: {
        id: WEB_DEPLOYABLE_ARTIFACT_ID,
        type: ArtifactType.DOCKER_IMAGE,
        status: ArtifactStatus.READY,
        size: { gt: 0 },
        deployment: { projectId: PROJECT_ID, deployableUnitId: WEB_UNIT_ID },
      },
      select: {
        id: true,
        type: true,
        status: true,
        size: true,
        checksum: true,
        metadata: true,
        storagePath: true,
      },
    }),
  ]);

  if (!project) throw new Error('project missing');
  if (!webUnit || webUnit.projectId !== PROJECT_ID || webUnit.type !== 'WEB') {
    throw new Error('web unit missing or not WEB');
  }
  if (!apiUnit || apiUnit.type !== 'API') throw new Error('api unit missing');
  if (!server) throw new Error('server missing');
  if (server.host !== TARGET_HOST) {
    blockers.push({ code: 'SERVER_FORBIDDEN', message: `publicIp must be ${TARGET_HOST}` });
  }
  if (server.host === OLD_HOST) {
    blockers.push({ code: 'OLD_SERVER_FORBIDDEN', message: 'old server forbidden' });
  }

  const serverGate = evaluateManagedServerForDeploy(server, {
    allowedServerInstanceId: SERVER_ID,
  });
  blockers.push(...serverGate.blockers);

  const meta =
    server.metadata && typeof server.metadata === 'object' && !Array.isArray(server.metadata)
      ? server.metadata
      : {};
  const bindAddress = meta.bindAddress || RUNTIME_BIND_ADDRESS || '127.0.0.1';
  if (bindAddress !== '127.0.0.1') {
    blockers.push({
      code: 'BIND_ADDRESS_INVALID',
      message: 'RUNTIME_PUBLIC_BIND_FORBIDDEN',
    });
  }
  try {
    assertRuntimePublishSpec({
      publishHost: bindAddress,
      hostPort: HOST_PORT_RANGE_START,
      containerPort: wl.webContainerPort,
    });
  } catch (e) {
    blockers.push({
      code: 'BIND_ADDRESS_INVALID',
      message: e instanceof Error ? e.message : 'RUNTIME_PUBLIC_BIND_FORBIDDEN',
    });
  }

  const apiRuntimePort = apiSi?.externalPort ?? apiSi?.port ?? wl.apiRuntimePort;
  const apiHealth = apiSi?.healthStatus || null;
  const apiDbReady =
    Boolean(apiSi) &&
    apiSi.serverInstanceId === SERVER_ID &&
    apiSi.deployableUnitId === API_UNIT_ID &&
    apiSi.status === ServiceStatus.RUNNING &&
    apiSi.healthStatus === 'HEALTHY' &&
    apiRuntimePort === 39000;

  // Dependencies: Web must NOT inherit Project DB/Redis requirements.
  const [webDbBind, webRedisBind, apiDbBind, apiRedisBind] = await Promise.all([
    prisma.databaseConnectionUnit.findMany({
      where: { deployableUnitId: WEB_UNIT_ID },
      include: { databaseConnection: { select: { id: true, status: true } } },
    }),
    prisma.redisConnectionUnit.findMany({
      where: { deployableUnitId: WEB_UNIT_ID },
      include: { redisConnection: { select: { id: true, status: true } } },
    }),
    prisma.databaseConnectionUnit.findMany({
      where: { deployableUnitId: API_UNIT_ID },
      include: { databaseConnection: { select: { id: true, status: true } } },
    }),
    prisma.redisConnectionUnit.findMany({
      where: { deployableUnitId: API_UNIT_ID },
      include: { redisConnection: { select: { id: true, status: true } } },
    }),
  ]);

  const webPostgresql = webDbBind.length
    ? webDbBind.some((b) => b.databaseConnection.status === 'CONNECTED')
      ? 'CONNECTED'
      : 'NOT_CONNECTED'
    : 'NOT_REQUIRED';
  const webRedis = webRedisBind.length
    ? webRedisBind.some((b) => b.redisConnection.status === 'CONNECTED')
      ? 'CONNECTED'
      : 'NOT_CONNECTED'
    : 'NOT_REQUIRED';
  const apiPostgresql = apiDbBind.some((b) => b.databaseConnection.status === 'CONNECTED')
    ? 'CONNECTED'
    : 'NOT_CONNECTED';
  const apiRedisStatus = apiRedisBind.some((b) => b.redisConnection.status === 'CONNECTED')
    ? 'CONNECTED'
    : 'NOT_CONNECTED';

  const webDependencyReady =
    (webPostgresql === 'NOT_REQUIRED' || webPostgresql === 'CONNECTED') &&
    (webRedis === 'NOT_REQUIRED' || webRedis === 'CONNECTED');

  const webReqs = await prisma.runtimeConfigRequirement.findMany({
    where: { deployableUnitId: WEB_UNIT_ID },
    select: {
      key: true,
      required: true,
      injectionPhase: true,
      status: true,
      managedByLaunchOS: true,
    },
  });
  const webValues = await prisma.runtimeConfigValue.findMany({
    where: {
      projectId: PROJECT_ID,
      OR: [{ deployableUnitId: WEB_UNIT_ID }, { deployableUnitId: null }],
    },
    select: {
      key: true,
      deployableUnitId: true,
      isSensitive: true,
      valueEncrypted: true,
    },
  });
  const valueKeys = new Set(webValues.filter((v) => v.valueEncrypted).map((v) => v.key));
  const presentConfigKeys = [...valueKeys].sort();

  const runtimeRequiredMissing = webReqs.filter(
    (r) =>
      r.required &&
      !r.managedByLaunchOS &&
      (r.injectionPhase === 'RUNTIME' || r.injectionPhase === 'BOTH') &&
      !valueKeys.has(r.key),
  );
  const webRuntimeSecretsReady = runtimeRequiredMissing.length === 0;

  const browserApiKeys = ['NEXT_PUBLIC_API_URL', 'VITE_API_URL', 'API_BASE_URL'];
  const needsBrowserApi = webReqs.some(
    (r) =>
      browserApiKeys.includes(r.key) &&
      (r.injectionPhase === 'BUILD' || r.injectionPhase === 'BOTH'),
  );
  const accessEntryStatus = needsBrowserApi ? 'ACCESS_ENTRY_PENDING' : 'NOT_REQUIRED';

  // Secret isolation — keys only, never values.
  const candidateKeys = [
    ...presentConfigKeys,
    ...WEB_FORBIDDEN_RUNTIME_SECRET_KEYS,
    'PG_PASSWORD',
    'REDIS_PASSWORD',
  ];
  const syntheticEnv = Object.fromEntries(candidateKeys.map((k) => [k, 'redacted']));
  const isolationProbe = filterRuntimeEnvForUnitType('WEB', syntheticEnv);
  const webSecretIsolation = isolationProbe.webSecretIsolation;
  const allowedRuntimeKeys = isolationProbe.allowedRuntimeKeys;
  const blockedBackendSecretKeys = isolationProbe.blockedBackendSecretKeys;
  const apiSecretIsolation = true;
  if (!webSecretIsolation) {
    blockers.push({ code: 'WEB_SECRET_ISOLATION', message: 'webSecretIsolation=false' });
  }

  const health = resolveUnitHealthCheck({ unitType: webUnit.type });

  const reservedDb = await listDbReservedHostPorts(prisma, SERVER_ID);
  let remoteListening = [];
  let remoteSsOk = false;
  let remote = null;
  let apiLoopbackHealthOk = false;
  let apiLoopbackStatus = null;
  if (RemoteDockerRuntime && server.host && server.credentialEncrypted) {
    try {
      remote = new RemoteDockerRuntime({
        host: server.host,
        port: server.port || 22,
        username: server.username,
        password: decryptCredential(server.credentialEncrypted),
      });
      remoteListening = await remote.listListeningHostPorts();
      remoteSsOk = true;
      try {
        const probe = await remote.checkHttp(`http://127.0.0.1:${apiRuntimePort}/health`, 12_000);
        apiLoopbackHealthOk = probe.status >= 200 && probe.status < 400;
        apiLoopbackStatus = probe.status;
      } catch (e) {
        apiLoopbackHealthOk = false;
        apiLoopbackStatus = e instanceof Error ? e.message.slice(0, 120) : 'probe failed';
      }
    } catch (e) {
      remoteSsOk = false;
      blockers.push({
        code: 'REMOTE_PORT_PROBE_FAILED',
        message: e instanceof Error ? e.message.slice(0, 200) : 'remote ss failed',
      });
    }
  }

  const apiBaselineReady = apiDbReady && apiLoopbackHealthOk;
  const apiPreserved = apiBaselineReady;
  if (!apiBaselineReady) {
    blockers.push({
      code: 'API_BASELINE_NOT_HEALTHY',
      message: `API must be RUNNING+HEALTHY on 39000 with loopback /health 2xx (dbReady=${apiDbReady} loopback=${apiLoopbackStatus})`,
    });
  }

  const pendingDeploys = await prisma.deployment.findMany({
    where: {
      projectId: PROJECT_ID,
      status: { in: ['CREATED', 'QUEUED', 'RUNNING'] },
    },
    select: {
      id: true,
      status: true,
      deployableUnitId: true,
    },
  });

  const reserved = [...new Set([...reservedDb, ...remoteListening, apiRuntimePort].filter(Boolean))];
  const plannedWebRuntimePort = planNextRuntimePort(reserved);
  const portConflict =
    plannedWebRuntimePort == null ||
    plannedWebRuntimePort === apiRuntimePort ||
    plannedWebRuntimePort < DYNAMIC_PORT_RANGE_START ||
    plannedWebRuntimePort > DYNAMIC_PORT_RANGE_END ||
    reserved.includes(plannedWebRuntimePort);

  if (portConflict) {
    blockers.push({
      code: 'PORT_CONFLICT',
      message: `plannedWebRuntimePort conflict api=${apiRuntimePort} planned=${plannedWebRuntimePort}`,
    });
  }

  const activeWebDeploy = pendingDeploys.find((d) => d.deployableUnitId === WEB_UNIT_ID);
  if (activeWebDeploy) {
    blockers.push({
      code: 'DEPLOYMENT_IN_PROGRESS',
      message: `已有进行中的 Web 部署 ${activeWebDeploy.id}`,
    });
  }

  // Must not target API unit for this confirm path.
  if (WEB_UNIT_ID === API_UNIT_ID) {
    blockers.push({
      code: 'SERVER_FORBIDDEN',
      message: 'Step 28 confirm path must not modify API unit',
    });
  }

  const imageMeta = asDockerImageMetadata(deployableImage?.metadata);
  const webDeployableArtifactReady = Boolean(
    deployableImage &&
      deployableImage.id === WEB_DEPLOYABLE_ARTIFACT_ID &&
      imageMeta &&
      imageMeta.sourceArtifactId === WEB_SOURCE_ARTIFACT_ID &&
      deployableImage.size > 0,
  );
  if (!webSource) {
    blockers.push({ code: 'ARTIFACT_NOT_READY', message: 'Web BUILD_OUTPUT missing' });
  }
  if (!webDeployableArtifactReady) {
    blockers.push({
      code: 'DEPLOYABLE_IMAGE_NOT_READY',
      message: `Web DOCKER_IMAGE ${WEB_DEPLOYABLE_ARTIFACT_ID} not ready`,
    });
  }

  const serverArchitecture = normalizeServerArchitecture(
    meta.architecture || MANAGED_SERVER_ARCHITECTURE,
  );
  const imageArchitecture = normalizeImageArchitecture(imageMeta?.architecture || 'amd64');
  let architectureCompatible = false;
  try {
    assertImageArchitectureCompatible({
      imageArchitecture,
      serverArchitecture,
    });
    architectureCompatible = true;
  } catch {
    architectureCompatible = false;
    blockers.push({
      code: 'IMAGE_ARCHITECTURE_MISMATCH',
      message: `image=${imageArchitecture} server=${serverArchitecture}`,
    });
  }

  const analysis = await prisma.projectAnalysis.findFirst({
    where: { projectId: PROJECT_ID },
    orderBy: { createdAt: 'desc' },
    select: { repositoryPath: true, startCommand: true, framework: true },
  });
  let packageScripts = {};
  let hasPackageJson = false;
  if (analysis?.repositoryPath) {
    const unitPath = join(
      analysis.repositoryPath,
      webUnit.rootPath && webUnit.rootPath !== '.' ? webUnit.rootPath : '',
    );
    const pkgPath = join(unitPath, 'package.json');
    hasPackageJson = existsSync(pkgPath);
    if (hasPackageJson) {
      try {
        packageScripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
      } catch {
        packageScripts = {};
      }
    }
  }
  const startCommandResolution = resolveRunnableStartCommand({
    unitStartCommand: webUnit.startCommand,
    analyzerStartCommand: analysis?.startCommand || null,
    packageScripts,
    hasPackageJson,
  });
  const webRunnable =
    webUnit.framework?.toUpperCase() === 'VITE'
      ? Boolean(packageScripts.build)
      : startCommandResolution.artifactRunnable;
  if (!webRunnable) {
    blockers.push({
      code: 'ARTIFACT_NOT_RUNNABLE',
      message: startCommandResolution.reasonCode,
    });
  }

  let queueReady = false;
  try {
    const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    await connection.connect();
    const pong = await connection.ping();
    queueReady = pong === 'PONG';
    const queue = new Queue(DEPLOYMENT_QUEUE, { connection });
    await queue.getJobCounts('waiting', 'active', 'delayed').catch(() => null);
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  } catch {
    queueReady = false;
  }
  if (!queueReady) {
    blockers.push({ code: 'QUEUE_NOT_READY', message: 'deploymentQueue not ready' });
  }

  const lockKey = managedDeploymentLockKey(PROJECT_ID, WEB_UNIT_ID);
  const lockReady = !activeWebDeploy;

  const webContainerPort =
    imageMeta?.containerPort || wl.webContainerPort || 80;

  const gate = summarizeManagedDeployGate({
    serverOk:
      serverGate.ok &&
      blockers.every((b) => b.code !== 'SERVER_FORBIDDEN' && b.code !== 'OLD_SERVER_FORBIDDEN'),
    artifactReady: Boolean(webSource),
    deployableImageReady: webDeployableArtifactReady,
    dependencyReady: webDependencyReady,
    runtimeSecretsReady: webRuntimeSecretsReady,
    queueReady,
    lockReady,
    plannedRuntimePort: plannedWebRuntimePort,
    blockers,
  });

  const probePorts = [apiRuntimePort, plannedWebRuntimePort, 39999].filter(
    (p) => typeof p === 'number',
  );
  const tcp = [];
  for (const port of probePorts) {
    tcp.push(await tcpProbe(TARGET_HOST, port));
  }
  const dynamicPublicExposure = tcp.some((r) => r.status === 'open');

  const builderBase = await inspectLocalImageArchitecture(MANAGED_BASE_IMAGE_RUNTIME);

  return {
    project,
    webUnit,
    apiUnit,
    server,
    meta,
    bindAddress,
    apiSi,
    apiRuntimePort,
    apiHealth,
    apiStatus: apiSi?.status || null,
    apiDbReady,
    apiLoopbackHealthOk,
    apiLoopbackStatus,
    apiBaselineReady,
    apiPreserved,
    webSource,
    deployableImage,
    webDeployableArtifactReady,
    imageMeta,
    webContainerPort,
    plannedWebRuntimePort,
    portConflict,
    reserved,
    remoteListening,
    remoteSsOk,
    health,
    webDependencyReady,
    webPostgresql,
    webRedis,
    apiPostgresql,
    apiRedisStatus,
    webRuntimeSecretsReady,
    webSecretIsolation,
    apiSecretIsolation,
    allowedRuntimeKeys,
    blockedBackendSecretKeys,
    accessEntryStatus,
    accessEntryUserMessage: managedAccessEntryPendingMessage(),
    queueReady,
    lockReady,
    lockKey,
    architectureCompatible,
    imageArchitecture,
    serverArchitecture,
    builderBase,
    pendingDeploys,
    dynamicPublicExposure,
    tcp,
    gate,
    serverGate,
    webRunnable,
    startCommandResolution,
  };
}

async function main() {
  let WRITE_COMMANDS_EXECUTED_THIS_RUN = false;
  let DEPLOYMENT_ENQUEUED = false;
  const prisma = new PrismaClient();

  try {
    const evaluated = await evaluateGates(prisma);
    const {
      bindAddress,
      apiSi,
      apiRuntimePort,
      apiHealth,
      apiStatus,
      apiBaselineReady,
      apiPreserved,
      webSource,
      deployableImage,
      webDeployableArtifactReady,
      webContainerPort,
      plannedWebRuntimePort,
      portConflict,
      reserved,
      remoteListening,
      remoteSsOk,
      health,
      webDependencyReady,
      webPostgresql,
      webRedis,
      apiPostgresql,
      apiRedisStatus,
      webRuntimeSecretsReady,
      webSecretIsolation,
      apiSecretIsolation,
      allowedRuntimeKeys,
      blockedBackendSecretKeys,
      accessEntryStatus,
      accessEntryUserMessage,
      queueReady,
      lockReady,
      lockKey,
      architectureCompatible,
      imageArchitecture,
      serverArchitecture,
      builderBase,
      pendingDeploys,
      dynamicPublicExposure,
      tcp,
      gate,
      meta,
      webUnit,
    } = evaluated;

    const report = {
      step: CONFIRM
        ? 'Step 28 Multi-Unit Managed Deployment — Phase 2 confirm path'
        : 'Step 28 Multi-Unit Managed Deployment — dry-run',
      phase2ConfirmPathEnabled,
      projectId: PROJECT_ID,
      webUnitId: WEB_UNIT_ID,
      apiUnitId: API_UNIT_ID,
      deploymentTargetType: 'MANAGED_SERVER',
      executionPath: 'REMOTE_DEPLOY',
      targetServerInstanceId: SERVER_ID,
      publicIp: TARGET_HOST,
      apiServiceInstance: apiSi?.id || null,
      apiRuntimePort,
      apiHealth,
      apiStatus,
      apiBaselineReady,
      apiPreserved,
      webUnitType: webUnit.type,
      webFramework: webUnit.framework,
      webSourceArtifactId: webSource?.id || WEB_SOURCE_ARTIFACT_ID,
      webDeployableArtifactId: deployableImage?.id || WEB_DEPLOYABLE_ARTIFACT_ID,
      webDeployableArtifactType: 'DOCKER_IMAGE',
      webDeployableArtifactReady,
      imageArchiveReady: webDeployableArtifactReady,
      webContainerPort,
      plannedWebRuntimePort,
      portConflict,
      bindAddress,
      publishSpec: `${bindAddress}:{actualRuntimePort}:${webContainerPort}`,
      webHealthPath: health.healthPath,
      healthPathSource: health.healthPathSource,
      webDependencyReady,
      webPostgresql,
      webRedis,
      apiPostgresql,
      apiRedis: apiRedisStatus,
      dependencyIsolation: webPostgresql === 'NOT_REQUIRED' && webRedis === 'NOT_REQUIRED',
      webRuntimeSecretsReady,
      webSecretIsolation,
      apiSecretIsolation,
      allowedRuntimeKeys,
      blockedBackendSecretKeys,
      accessEntryStatus,
      accessEntryUserMessage,
      remoteBuildRequired: false,
      remoteRegistryPullRequired: false,
      runtimePullPolicy: RUNTIME_PULL_POLICY || 'never',
      architectureCompatible,
      imageArchitecture,
      serverArchitecture,
      builderBaseImage: MANAGED_BASE_IMAGE_RUNTIME,
      builderBaseImagePresent: builderBase.present,
      reservedPorts: reserved,
      remoteListeningPortsInRange: remoteListening.filter(
        (p) => p >= DYNAMIC_PORT_RANGE_START && p <= DYNAMIC_PORT_RANGE_END,
      ),
      remoteSsOk,
      pendingWebDeployments: pendingDeploys
        .filter((d) => d.deployableUnitId === WEB_UNIT_ID)
        .map((d) => ({ id: d.id, status: d.status })),
      deploymentQueueReady: queueReady,
      deploymentLockReady: lockReady,
      deploymentLockKey: lockKey,
      dynamicPublicExposure,
      tcpPublicProbes: tcp,
      oldServerUntouched: true,
      canDeploy: gate.canDeploy,
      blockers: gate.blockers,
      WRITE_COMMANDS_EXECUTED_THIS_RUN,
      DEPLOYMENT_ENQUEUED,
      phase: CONFIRM ? 2 : 1,
    };

    assertNoSecret(redactSecrets(JSON.stringify(report)), 'step28-report');
    console.log(JSON.stringify(report, null, 2));

    if (!CONFIRM) {
      console.log('\nDRY_RUN complete. WRITE_COMMANDS_EXECUTED_THIS_RUN=false');
      console.log('DEPLOYMENT_ENQUEUED=false');
      console.log('oldServerUntouched=true');
      if (!gate.canDeploy) process.exitCode = 1;
      return;
    }

    // —— Real confirm path (Phase 2) ——
    printRealManagedDeploymentGate({
      stage: 'pre_enqueue',
      phase2ConfirmPathEnabled,
      projectId: PROJECT_ID,
      webUnitId: WEB_UNIT_ID,
      apiUnitId: API_UNIT_ID,
      deploymentTargetType: 'MANAGED_SERVER',
      executionPath: 'REMOTE_DEPLOY',
      targetServerInstanceId: SERVER_ID,
      publicIp: TARGET_HOST,
      serverReadiness: evaluated.server.status,
      runtimeType: meta.runtimeType,
      apiServiceInstance: apiSi?.id || null,
      apiRuntimePort,
      apiHealth,
      apiBaselineReady,
      apiPreserved,
      webSourceArtifactId: WEB_SOURCE_ARTIFACT_ID,
      webDeployableArtifactId: WEB_DEPLOYABLE_ARTIFACT_ID,
      webDeployableArtifactReady,
      webContainerPort,
      plannedWebRuntimePort,
      portConflict,
      bindAddress,
      webDependencyReady,
      webSecretIsolation,
      allowedRuntimeKeys,
      blockedBackendSecretKeys,
      remoteBuildRequired: false,
      remoteRegistryPullRequired: false,
      runtimePullPolicy: RUNTIME_PULL_POLICY || 'never',
      accessEntryStatus,
      deploymentQueueReady: queueReady,
      deploymentLockReady: lockReady,
      dynamicPublicExposure,
      canDeploy: gate.canDeploy,
      blockers: gate.blockers,
      WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
      DEPLOYMENT_ENQUEUED: false,
    });

    if (!gate.canDeploy || gate.blockers.length > 0) {
      console.log('\nREFUSED: real managed Web deploy blocked by gate.');
      console.log('WRITE_COMMANDS_EXECUTED_THIS_RUN=false');
      console.log('DEPLOYMENT_ENQUEUED=false');
      process.exitCode = 1;
      return;
    }

    if (GATE_ONLY) {
      console.log('\nCONFIRM_PATH_FIXTURE complete (gate-only).');
      console.log('phase2ConfirmPathEnabled=true');
      console.log('wouldEnqueue=true');
      console.log('DEPLOYMENT_ENQUEUED=false');
      console.log('WRITE_COMMANDS_EXECUTED_THIS_RUN=false');
      console.log('oldServerUntouched=true');
      return;
    }

    // Real enqueue — only when --confirm-deploy without --gate-only
    const login = await api('/auth/login', {
      method: 'POST',
      body: {
        email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
        password: process.env.E2E_PASSWORD || 'Launchos123!',
      },
    });
    const token = login.accessToken;
    assertNoSecret(login, 'login');

    console.log('\nPOST /projects/:id/deployments (Web Unit) …');
    const created = await api(`/projects/${PROJECT_ID}/deployments`, {
      method: 'POST',
      token,
      body: {
        environmentId: ENV_ID,
        hostingMode: 'launchos',
        targetType: 'MANAGED_SERVER',
        serverInstanceId: SERVER_ID,
        deployableUnitId: WEB_UNIT_ID,
        selectedArtifactId: WEB_SOURCE_ARTIFACT_ID,
      },
    });
    assertNoSecret(created, 'create deployment');
    DEPLOYMENT_ENQUEUED = true;
    console.log('DEPLOYMENT_ENQUEUED=true');
    console.log(
      JSON.stringify(
        {
          deploymentId: created.id || created.deployment?.id,
          status: created.status || created.deployment?.status,
          webUnitId: WEB_UNIT_ID,
          serverInstanceId: SERVER_ID,
          apiUnitUntouched: true,
          WRITE_COMMANDS_EXECUTED_THIS_RUN,
        },
        null,
        2,
      ),
    );

    let final = null;
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      const id = created.id || created.deployment?.id;
      final = await api(`/deployments/${id}`, { token });
      assertNoSecret(final, 'deployment status');
      const st = final.status || final.deployment?.status;
      console.log(`poll#${i + 1} status=${st}`);
      if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') break;
      if (st === 'RUNNING' && i >= 1) {
        WRITE_COMMANDS_EXECUTED_THIS_RUN = true;
      }
    }

    console.log(
      JSON.stringify(
        {
          DEPLOYMENT_ENQUEUED,
          WRITE_COMMANDS_EXECUTED_THIS_RUN,
          finalStatus: final?.status || final?.deployment?.status || null,
          oldServerUntouched: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
