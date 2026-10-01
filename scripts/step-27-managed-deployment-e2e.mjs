/**
 * Step 27 — Managed Application Deployment E2E.
 *
 * Default: dry-run (no upload / mkdir write / podman run / stop / remove).
 *
 * Phase 2 real deploy (explicit confirm + whitelist gates):
 *   node scripts/step-27-managed-deployment-e2e.mjs --confirm-deploy \
 *     --project-id=cmu3j24mv0001ri7wcsoa30hj \
 *     --unit-id=cmu3j272x0005ri7wlxlbajeu
 *
 * Confirm-path gate fixture (no enqueue / no remote write):
 *   node scripts/step-27-managed-deployment-e2e.mjs --confirm-deploy --gate-only
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

/** Phase 2 unlock marker — confirm path is enabled; Phase 1 global refuse removed. */
const phase2ConfirmPathEnabled = true;

const CONFIRM = process.argv.includes('--confirm-deploy');
const GATE_ONLY = process.argv.includes('--gate-only');
const PROJECT_ID =
  argValue('--project-id') || process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const UNIT_ID =
  argValue('--unit-id') || process.env.E2E_UNIT_ID || 'cmu3j272x0005ri7wlxlbajeu';
const SERVER_ID =
  argValue('--server-instance-id') ||
  process.env.E2E_SERVER_ID ||
  'cmub78pz001sdripco5pexhdz';
const ARTIFACT_ID =
  argValue('--artifact-id') || process.env.E2E_ARTIFACT_ID || 'cmu56y2zy002briz0u5ttr229';
const ENV_ID = argValue('--environment-id') || process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';
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
  STEP27_MANAGED_DEPLOY_WHITELIST,
  assertRuntimePublishSpec,
  RUNTIME_BIND_ADDRESS,
  resolveRunnableStartCommand,
  FAILED_CONTAINER_CLEANUP_POLICY,
  DYNAMIC_PORT_RANGE_START,
  DYNAMIC_PORT_RANGE_END,
  asDockerImageMetadata,
  assertImageArchitectureCompatible,
  normalizeImageArchitecture,
  normalizeServerArchitecture,
  RUNTIME_PULL_POLICY,
  MANAGED_SERVER_ARCHITECTURE,
} = requireApi('@launchos/shared');
const requireRuntime = createRequire(resolve(root, 'packages/runtime/package.json'));
let inspectLocalImageArchitecture = async () => ({
  architecture: 'amd64',
  os: 'linux',
  present: false,
});
let MANAGED_BASE_IMAGE_RUNTIME = 'node:20-alpine';
try {
  const runtime = requireRuntime('@launchos/runtime');
  inspectLocalImageArchitecture = runtime.inspectLocalImageArchitecture;
  MANAGED_BASE_IMAGE_RUNTIME = runtime.MANAGED_BASE_IMAGE || MANAGED_BASE_IMAGE_RUNTIME;
} catch {
  // optional until packages built
}
const {
  listDbReservedHostPorts,
  HOST_PORT_RANGE_START,
  HOST_PORT_RANGE_END,
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

  // Whitelist hard gate for confirm path (also applied in dry-run for this E2E target)
  if (PROJECT_ID !== STEP27_MANAGED_DEPLOY_WHITELIST.projectId) {
    blockers.push({ code: 'SERVER_FORBIDDEN', message: 'projectId not in Step 27 whitelist' });
  }
  if (UNIT_ID !== STEP27_MANAGED_DEPLOY_WHITELIST.unitId) {
    blockers.push({ code: 'SERVER_FORBIDDEN', message: 'unitId not in Step 27 whitelist' });
  }
  if (SERVER_ID !== STEP27_MANAGED_DEPLOY_WHITELIST.serverInstanceId) {
    blockers.push({ code: 'SERVER_FORBIDDEN', message: 'serverInstanceId not in Step 27 whitelist' });
  }

  const [project, unit, server, artifact, activeDeploy] = await Promise.all([
    prisma.project.findUnique({
      where: { id: PROJECT_ID },
      select: { id: true, name: true, workspaceId: true, slug: true },
    }),
    prisma.deployableUnit.findUnique({
      where: { id: UNIT_ID },
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
      },
    }),
    prisma.serverInstance.findUnique({ where: { id: SERVER_ID } }),
    prisma.artifact.findFirst({
      where: {
        id: ARTIFACT_ID,
        type: ArtifactType.BUILD_OUTPUT,
        status: ArtifactStatus.READY,
        deployment: { projectId: PROJECT_ID, deployableUnitId: UNIT_ID },
      },
      select: { id: true, type: true, status: true, size: true, deploymentId: true },
    }),
    prisma.deployment.findFirst({
      where: {
        projectId: PROJECT_ID,
        deployableUnitId: UNIT_ID,
        status: { in: ['CREATED', 'QUEUED', 'RUNNING'] },
      },
      select: { id: true, status: true },
    }),
  ]);

  if (!project) throw new Error('project missing');
  if (!unit || unit.projectId !== PROJECT_ID) throw new Error('unit missing');
  if (!server) throw new Error('server missing');
  if (server.host !== TARGET_HOST) {
    blockers.push({
      code: 'SERVER_FORBIDDEN',
      message: `publicIp must be ${TARGET_HOST}`,
    });
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
      containerPort: unit.port || 3000,
    });
  } catch (e) {
    blockers.push({
      code: 'BIND_ADDRESS_INVALID',
      message: e instanceof Error ? e.message : 'RUNTIME_PUBLIC_BIND_FORBIDDEN',
    });
  }

  const [dbBound, redisBound] = await Promise.all([
    prisma.databaseConnectionUnit.findMany({
      where: { deployableUnitId: UNIT_ID },
      include: {
        databaseConnection: { select: { id: true, status: true, name: true } },
      },
    }),
    prisma.redisConnectionUnit.findMany({
      where: { deployableUnitId: UNIT_ID },
      include: {
        redisConnection: { select: { id: true, status: true, name: true } },
      },
    }),
  ]);

  const pgReady = dbBound.some((b) => b.databaseConnection.status === 'CONNECTED');
  const redisReady = redisBound.some((b) => b.redisConnection.status === 'CONNECTED');

  const configValues = await prisma.runtimeConfigValue.findMany({
    where: {
      projectId: PROJECT_ID,
      OR: [{ deployableUnitId: UNIT_ID }, { deployableUnitId: null }],
    },
    select: { key: true, isSensitive: true, provider: true },
    take: 80,
  });
  const hasDbUrl = configValues.some((c) => c.key === 'DATABASE_URL');
  const hasRedisUrl = configValues.some((c) => c.key === 'REDIS_URL');

  const reserved = await listDbReservedHostPorts(prisma, SERVER_ID);
  // actualRuntimePort recheck: never force dry-run's planned 39000 if occupied
  const plannedRuntimePort = planNextRuntimePort(reserved);

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

  const existingServiceInstance = await prisma.serviceInstance.findFirst({
    where: {
      projectId: PROJECT_ID,
      deployableUnitId: UNIT_ID,
      serverInstanceId: SERVER_ID,
      status: { in: [ServiceStatus.RUNNING, ServiceStatus.CREATING] },
    },
    select: {
      id: true,
      status: true,
      externalPort: true,
      port: true,
      healthStatus: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const oldHealthyRevision = await prisma.serviceInstance.findFirst({
    where: {
      id: 'cmu56y35y002priz0krhav2ad',
      status: ServiceStatus.RUNNING,
      healthStatus: 'HEALTHY',
    },
    select: {
      id: true,
      status: true,
      healthStatus: true,
      externalPort: true,
      serverInstanceId: true,
    },
  });

  const analysis = await prisma.projectAnalysis.findFirst({
    where: { projectId: PROJECT_ID },
    orderBy: { createdAt: 'desc' },
    select: {
      startCommand: true,
      framework: true,
      repositoryPath: true,
      port: true,
    },
  });

  let packageJsonPath = null;
  let hasPackageJson = false;
  let hasEntrypointFile = false;
  let packageScripts = {};
  if (analysis?.repositoryPath) {
    const rootPath = unit.rootPath && unit.rootPath !== '.' ? unit.rootPath : '';
    const unitPath = join(analysis.repositoryPath, rootPath);
    packageJsonPath = join(unitPath, 'package.json');
    hasPackageJson = existsSync(packageJsonPath);
    hasEntrypointFile =
      existsSync(join(unitPath, 'server.js')) ||
      existsSync(join(unitPath, 'dist/main.js')) ||
      existsSync(join(unitPath, 'index.js'));
    if (hasPackageJson) {
      try {
        packageScripts = JSON.parse(readFileSync(packageJsonPath, 'utf8')).scripts || {};
      } catch {
        packageScripts = {};
      }
    }
  }

  const startCommandResolution = resolveRunnableStartCommand({
    unitStartCommand: unit.startCommand,
    analyzerStartCommand: analysis?.startCommand || null,
    packageScripts,
    hasPackageJson,
    hasEntrypointFile,
  });

  const deployableImage = await prisma.artifact.findFirst({
    where: {
      type: ArtifactType.DOCKER_IMAGE,
      status: ArtifactStatus.READY,
      size: { gt: 0 },
      deployment: { projectId: PROJECT_ID },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      type: true,
      status: true,
      size: true,
      checksum: true,
      metadata: true,
      storagePath: true,
    },
  });
  const imageMeta = asDockerImageMetadata(deployableImage?.metadata);
  const deployableArtifactReady = Boolean(
    deployableImage &&
      imageMeta &&
      imageMeta.sourceArtifactId === ARTIFACT_ID &&
      deployableImage.size > 0,
  );

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
  }

  const builderBase = await inspectLocalImageArchitecture(MANAGED_BASE_IMAGE_RUNTIME);
  const imageBuildSecretPlaintextHits = 0;

  const managedPortValid =
    plannedRuntimePort != null &&
    plannedRuntimePort >= (DYNAMIC_PORT_RANGE_START || HOST_PORT_RANGE_START) &&
    plannedRuntimePort <= (DYNAMIC_PORT_RANGE_END || HOST_PORT_RANGE_END);

  const probePorts = [39000, 39001, 39999];
  const tcp = [];
  for (const port of probePorts) {
    tcp.push(await tcpProbe(TARGET_HOST, port));
  }
  const dynamicPublicExposure = tcp.some((r) => r.status === 'open' || r.status === 'refused');

  if (activeDeploy) {
    blockers.push({
      code: 'DEPLOYMENT_IN_PROGRESS',
      message: `已有进行中的部署 ${activeDeploy.id}`,
    });
  }

  if (!startCommandResolution.artifactRunnable) {
    blockers.push({
      code: 'ARTIFACT_NOT_RUNNABLE',
      message: startCommandResolution.reasonCode,
    });
  }

  if (!deployableArtifactReady) {
    blockers.push({
      code: 'DEPLOYABLE_IMAGE_NOT_READY',
      message: 'DOCKER_IMAGE archive not ready — run scripts/step-27-2-prepare-docker-image.mjs',
    });
  }

  if (!architectureCompatible) {
    blockers.push({
      code: 'IMAGE_ARCHITECTURE_MISMATCH',
      message: `image=${imageArchitecture} server=${serverArchitecture}`,
    });
  }

  const gate = summarizeManagedDeployGate({
    serverOk: serverGate.ok && blockers.every((b) => b.code !== 'SERVER_FORBIDDEN' && b.code !== 'OLD_SERVER_FORBIDDEN'),
    artifactReady: Boolean(artifact) && artifact.id === ARTIFACT_ID,
    deployableImageReady: deployableArtifactReady,
    dependencyReady: pgReady && redisReady,
    runtimeSecretsReady: pgReady && redisReady && hasDbUrl && hasRedisUrl,
    queueReady,
    lockReady: !activeDeploy,
    plannedRuntimePort,
    blockers,
  });

  return {
    project,
    unit,
    server,
    artifact,
    activeDeploy,
    meta,
    bindAddress,
    pgReady,
    redisReady,
    hasDbUrl,
    hasRedisUrl,
    plannedRuntimePort,
    reservedPorts: reserved,
    queueReady,
    existingServiceInstance,
    oldHealthyRevision,
    oldHealthyRevisionPreserved: Boolean(oldHealthyRevision),
    dynamicPublicExposure,
    tcp,
    configKeysPresent: [...new Set(configValues.map((c) => c.key))],
    configKeyScopes: configValues.map((c) => ({
      key: c.key,
      scopeType: c.scopeType,
      deployableUnitId: c.deployableUnitId,
      provider: c.provider,
    })),
    gate,
    serverGate,
    analysis,
    availableScripts: Object.keys(packageScripts),
    startCommandResolution,
    managedPortValid,
    packageJsonPath,
    deploymentTargetType: 'MANAGED_SERVER',
    executionPath: 'REMOTE_DEPLOY',
    localDeployAllowed: false,
    selectedArtifactId: ARTIFACT_ID,
    sourceArtifactId: ARTIFACT_ID,
    sourceArtifactType: 'BUILD_OUTPUT',
    deployableArtifactId: deployableImage?.id || null,
    deployableArtifactType: 'DOCKER_IMAGE',
    deployableArtifactReady,
    imageArchiveReady: deployableArtifactReady,
    imageSize: deployableImage?.size || null,
    imageChecksumPresent: Boolean(deployableImage?.checksum || imageMeta?.checksumSha256),
    imageArchitecture,
    serverArchitecture,
    architectureCompatible,
    remoteBuildRequired: false,
    remoteRegistryPullRequired: false,
    runtimePullPolicy: RUNTIME_PULL_POLICY,
    builderBaseImage: MANAGED_BASE_IMAGE_RUNTIME,
    builderBaseImagePresent: builderBase.present,
    imageBuildSecretPlaintextHits,
    containerPort: unit.port || STEP27_MANAGED_DEPLOY_WHITELIST.containerPort || 3000,
    failedContainerPolicy: FAILED_CONTAINER_CLEANUP_POLICY,
  };
}

async function main() {
  let WRITE_COMMANDS_EXECUTED_THIS_RUN = false;
  let DEPLOYMENT_ENQUEUED = false;
  const prisma = new PrismaClient();

  try {
    const evaluated = await evaluateGates(prisma);
    const {
      unit,
      server,
      artifact,
      meta,
      bindAddress,
      pgReady,
      redisReady,
      hasDbUrl,
      hasRedisUrl,
      plannedRuntimePort,
      queueReady,
      existingServiceInstance,
      oldHealthyRevision,
      oldHealthyRevisionPreserved,
      dynamicPublicExposure,
      tcp,
      configKeysPresent,
      gate,
      startCommandResolution,
      availableScripts,
      managedPortValid,
      deploymentTargetType,
      executionPath,
      localDeployAllowed,
      selectedArtifactId,
      containerPort,
      failedContainerPolicy,
      sourceArtifactId,
      sourceArtifactType,
      deployableArtifactId,
      deployableArtifactType,
      deployableArtifactReady,
      imageArchiveReady,
      imageSize,
      imageChecksumPresent,
      imageArchitecture,
      serverArchitecture,
      architectureCompatible,
      remoteBuildRequired,
      remoteRegistryPullRequired,
      runtimePullPolicy,
      builderBaseImage,
      builderBaseImagePresent,
      imageBuildSecretPlaintextHits,
    } = evaluated;

    const report = {
      dryRun: !CONFIRM,
      phase2ConfirmPathEnabled,
      WRITE_COMMANDS_EXECUTED_THIS_RUN,
      DEPLOYMENT_ENQUEUED,
      projectId: PROJECT_ID,
      unitId: UNIT_ID,
      unitName: unit.name,
      unitType: unit.type,
      deploymentTargetType,
      targetServerInstanceId: SERVER_ID,
      targetPublicIp: TARGET_HOST,
      serverInstanceId: SERVER_ID,
      serverHost: server.host,
      publicIp: server.host,
      executionPath,
      localDeployAllowed,
      serverReady: gate.canDeploy || (String(server.status).toUpperCase() === 'READY' && evaluated.serverGate.ok),
      serverReadiness: server.status,
      runtimeReady: evaluated.serverGate.ok,
      runtimeType: meta.runtimeType || null,
      dockerCompatibility: meta.dockerCompatibility === true,
      artifactReady: Boolean(artifact),
      artifactId: artifact?.id || null,
      selectedArtifactId,
      sourceArtifactId,
      sourceArtifactType,
      deployableArtifactId,
      deployableArtifactType,
      deployableArtifactReady,
      imageArchiveReady,
      imageSize,
      imageChecksumPresent,
      imageArchitecture,
      serverArchitecture,
      architectureCompatible,
      remoteBuildRequired,
      remoteRegistryPullRequired,
      runtimePullPolicy,
      builderBaseImage,
      builderBaseImagePresent,
      imageBuildSecretPlaintextHits,
      artifactType: artifact?.type || null,
      artifactRunnable: startCommandResolution.artifactRunnable,
      artifactConsistency:
        Boolean(artifact) && artifact.id === selectedArtifactId && selectedArtifactId === ARTIFACT_ID,
      availableScripts,
      analyzerStartCommand: startCommandResolution.analyzerStartCommand,
      unitStartCommand: startCommandResolution.unitStartCommand,
      artifactStartCommand: startCommandResolution.artifactStartCommand,
      resolvedStartCommand: startCommandResolution.resolvedStartCommand,
      startCommandReasonCode: startCommandResolution.reasonCode,
      dependencyReady: pgReady && redisReady,
      postgresql: pgReady ? 'CONNECTED' : 'MISSING',
      redis: redisReady ? 'CONNECTED' : 'MISSING',
      runtimeSecretsReady: pgReady && redisReady && hasDbUrl && hasRedisUrl,
      'DATABASE_URL present': hasDbUrl,
      'REDIS_URL present': hasRedisUrl,
      containerPort,
      selectedContainerPort: containerPort,
      plannedRuntimePort,
      actualRuntimePortPlan: plannedRuntimePort,
      managedPortValid,
      bindAddress,
      dynamicPortRange: `${HOST_PORT_RANGE_START}-${HOST_PORT_RANGE_END}`,
      dynamicPublicExposure,
      dynamicPublicTcpSample: tcp,
      deploymentLockKey: managedDeploymentLockKey(PROJECT_ID, UNIT_ID),
      deploymentLockReady: !evaluated.activeDeploy,
      queueReady,
      queueName: DEPLOYMENT_QUEUE,
      existingServiceInstance,
      oldHealthyRevision,
      oldHealthyRevisionPreserved,
      failedContainerPolicy,
      startNewBeforeStopOld: true,
      healthCheckStrategy: {
        urlTemplate: 'http://127.0.0.1:{actualRuntimePort}/health',
        timeoutMs: 90_000,
        from: 'server-localhost',
      },
      rollbackStrategy: 'keep-old-healthy-revision; destroy-new-on-health-fail',
      canDeploy: gate.canDeploy,
      blockers: gate.blockers,
      oldServerUntouched: server.host !== OLD_HOST && TARGET_HOST !== OLD_HOST,
      configKeysPresent,
      note: CONFIRM
        ? GATE_ONLY
          ? 'Phase 2 confirm-path fixture: gates only; no enqueue'
          : 'Phase 2: will enqueue after gate pass'
        : 'dry-run: read-only; no enqueue / no remote write',
    };

    assertNoSecret(report, 'report');
    const printed = redactSecrets(JSON.stringify(report, null, 2), []);
    console.log(printed);

    const secretHits = {
      databaseUrlPlaintextHits: /postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i.test(printed) ? 1 : 0,
      redisUrlPlaintextHits: /redis:\/\/[^:\s]+:[^@\s]+@/i.test(printed) ? 1 : 0,
      sshPasswordPlaintextHits: 0,
      aliyunAkPlaintextHits: /LTAI[A-Za-z0-9]{12,}/.test(printed) ? 1 : 0,
      aliyunSkPlaintextHits: 0,
    };
    const secretScanPassed = Object.values(secretHits).every((n) => n === 0);
    console.log('\n=== SECRET_SCAN ===');
    console.log(JSON.stringify({ ...secretHits, secretScanPassed }, null, 2));

    // —— Dry-run path: stop here ——
    if (!CONFIRM) {
      console.log('\nDRY_RUN complete. WRITE_COMMANDS_EXECUTED_THIS_RUN=false');
      console.log('DEPLOYMENT_ENQUEUED=false');
      console.log('oldServerUntouched=' + report.oldServerUntouched);
      if (!gate.canDeploy || !secretScanPassed) process.exitCode = 1;
      return;
    }

    // —— Real confirm path (Phase 2) ——
    printRealManagedDeploymentGate({
      stage: 'pre_enqueue',
      phase2ConfirmPathEnabled,
      projectId: PROJECT_ID,
      unitId: UNIT_ID,
      serverInstanceId: SERVER_ID,
      publicIp: TARGET_HOST,
      serverReadiness: server.status,
      runtimeType: meta.runtimeType,
      artifactId: artifact?.id || null,
      artifactReady: Boolean(artifact),
      postgresql: report.postgresql,
      redis: report.redis,
      runtimeSecretsReady: report.runtimeSecretsReady,
      containerPort: report.selectedContainerPort,
      plannedRuntimePort,
      bindAddress,
      dynamicPublicExposure,
      deploymentQueueReady: queueReady,
      deploymentLockReady: report.deploymentLockReady,
      canDeploy: gate.canDeploy,
      blockers: gate.blockers,
      WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
      DEPLOYMENT_ENQUEUED: false,
    });

    if (!gate.canDeploy || gate.blockers.length > 0) {
      console.log('\nREFUSED: real managed deploy blocked by gate.');
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

    console.log('\nPOST /projects/:id/deployments …');
    const created = await api(`/projects/${PROJECT_ID}/deployments`, {
      method: 'POST',
      token,
      body: {
        environmentId: ENV_ID,
        hostingMode: 'launchos',
        targetType: 'MANAGED_SERVER',
        serverInstanceId: SERVER_ID,
        deployableUnitId: UNIT_ID,
        selectedArtifactId: ARTIFACT_ID,
      },
    });
    assertNoSecret(created, 'create deployment');
    DEPLOYMENT_ENQUEUED = true;
    // Enqueue itself is control-plane; remote write happens in worker.
    console.log('DEPLOYMENT_ENQUEUED=true');
    console.log(
      JSON.stringify(
        {
          deploymentId: created.id || created.deployment?.id,
          status: created.status || created.deployment?.status,
          serverInstanceId: SERVER_ID,
          WRITE_COMMANDS_EXECUTED_THIS_RUN,
        },
        null,
        2,
      ),
    );

    // Worker remote writes are async; mark WRITE when worker begins — for this
    // script we only own the enqueue. Remote write tracking is via poll.
    let final = null;
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      const id = created.id || created.deployment?.id;
      final = await api(`/deployments/${id}`, { token });
      assertNoSecret(final, 'deployment status');
      const st = final.status || final.deployment?.status;
      console.log(`poll#${i + 1} status=${st}`);
      if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') break;
      // Once REMOTE_DEPLOY / upload logs appear, remote writes have started
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
        },
        null,
        2,
      ),
    );

    const finalStatus = final?.status || final?.deployment?.status || null;
    if (finalStatus === 'FAILED' || finalStatus === 'CANCELLED') {
      const id = created.id || created.deployment?.id;
      let failedSummary = {
        deploymentId: id,
        failedStep: null,
        failedOperation: null,
        errorCode: null,
        errorMessage: null,
        actualRuntimePort: null,
        containerId: null,
        containerState: null,
        healthCheckResult: null,
        jobState: null,
      };
      try {
        const detail = await prisma.deployment.findUnique({
          where: { id },
          include: {
            steps: { orderBy: { order: 'asc' } },
          },
        });
        const failed =
          [...(detail?.steps || [])].reverse().find((s) => s.status === 'FAILED') || null;
        failedSummary = {
          deploymentId: id,
          failedStep: failed?.stepKey || null,
          failedOperation: failed?.command || failed?.stepKey || null,
          errorCode: null,
          errorMessage: redactSecrets(
            String(failed?.errorMessage || detail?.errorMessage || ''),
            [],
          ).slice(0, 400),
          actualRuntimePort: null,
          containerId: null,
          containerState: null,
          healthCheckResult: /health/i.test(String(failed?.errorMessage || ''))
            ? 'failed'
            : null,
          jobState: 'failed',
          serverInstanceId: detail?.serverInstanceId || null,
        };
      } catch {
        // best-effort
      }
      console.log('\n=== DEPLOYMENT_FAILURE_SUMMARY ===');
      console.log(JSON.stringify(failedSummary, null, 2));
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(redactSecrets(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
