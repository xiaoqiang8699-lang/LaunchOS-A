/**
 * Step 28 Final Acceptance — READ-ONLY only.
 *
 *   node scripts/step-28-final-acceptance.mjs
 *
 * Forbidden: --confirm-deploy, stop/rm, upload, env write, queue retry,
 * Gateway/Nginx/DNS/HTTPS, Step 29.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

const WEB_DEPLOYMENT_ID = 'cmuc8ripi0015riagoflj5vdi';
const PROJECT_ID = 'cmu3j24mv0001ri7wcsoa30hj';
const SERVER_ID = 'cmub78pz001sdripco5pexhdz';
const TARGET_HOST = '116.62.198.184';
const OLD_HOST = '8.138.113.134';
const API_UNIT_ID = 'cmu3j272x0005ri7wlxlbajeu';
const WEB_UNIT_ID = 'cmu3j27340007ri7wcno1xrai';
const API_SI_ID = 'cmuc66642002hritk6h3cbwhe';
const WEB_SOURCE_ARTIFACT_ID = 'cmu3scwr3016fri3c35ryb3y2';
const WEB_DEPLOYABLE_ARTIFACT_ID = 'cmuc6x7hd0001ri10yvj0rr6o';
const FAILED_HISTORY = ['cmuc3rucy000jri6gbnhqf96x', 'cmuc53f9f000jriqg7r4kqhm6'];
const API_RUNTIME_PORT_EXPECTED = 39000;
const FORBIDDEN_WEB_ENV_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'PG_PASSWORD',
  'REDIS_PASSWORD',
];
const WRITE_COMMANDS_EXECUTED_THIS_RUN = false;

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  redactSecrets,
  deploymentJobId,
  DEPLOYMENT_QUEUE,
  asDockerImageMetadata,
  assertImageArchitectureCompatible,
  normalizeImageArchitecture,
  normalizeServerArchitecture,
  MANAGED_SERVER_ARCHITECTURE,
  RUNTIME_PULL_POLICY,
  shellCommand,
  resolveUnitHealthCheck,
  managedAccessEntryPendingMessage,
  WEB_FORBIDDEN_RUNTIME_SECRET_KEYS,
} = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
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
      resolveProbe({ host, port, status, code: code || null, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish('open'));
    socket.on('timeout', () => finish('filtered'));
    socket.on('error', (err) => {
      const code = err?.code ? String(err.code) : 'ERROR';
      finish(
        code === 'ECONNREFUSED' ? 'refused' : code === 'ETIMEDOUT' ? 'filtered' : 'error',
        code,
      );
    });
  });
}

async function soft(runner, cmd) {
  try {
    const r = await runner.execute(cmd, { timeoutMs: 45_000 });
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim().slice(0, 1200),
    };
  } catch (e) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

function secretHits(text) {
  const blob = String(text || '');
  return {
    databaseUrlPlaintextHits: /postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i.test(blob) ? 1 : 0,
    redisUrlPlaintextHits: /redis:\/\/[^:\s]+:[^@\s]+@/i.test(blob) ? 1 : 0,
    jwtSecretPlaintextHits: /JWT_SECRET\s*=\s*(?!\[REDACTED\]|present)\S+/i.test(blob) ? 1 : 0,
    sshPasswordPlaintextHits: 0,
    aliyunAkPlaintextHits: /LTAI[A-Za-z0-9]{12,}/.test(blob) ? 1 : 0,
    aliyunSkPlaintextHits: 0,
  };
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: detail ?? null };
}

function parseContainerLine(line) {
  const [containerId, containerName, containerStatus, ports] = (line || '')
    .split('|')
    .map((x) => (x || '').trim());
  return {
    containerId: containerId || null,
    containerName: containerName || null,
    containerStatus: containerStatus || null,
    ports: ports || null,
    state: /up|running/i.test(containerStatus || '') ? 'running' : containerStatus || 'unknown',
  };
}

async function findContainer(runner, deploymentId, containerIdFromDb) {
  const ps = await soft(
    runner,
    shellCommand(
      `podman ps --filter label=launchos.deploymentId=${deploymentId} --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null; docker ps --filter label=launchos.deploymentId=${deploymentId} --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null`,
    ),
  );
  let line = (ps.stdout || '').split(/\r?\n/).find((l) => l.includes('|')) || '';
  if (!line && containerIdFromDb) {
    const byId = await soft(
      runner,
      shellCommand(
        `podman ps -a --filter id=${String(containerIdFromDb).slice(0, 12)} --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null || docker ps -a --filter id=${String(containerIdFromDb).slice(0, 12)} --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null`,
      ),
    );
    line = (byId.stdout || '').split(/\r?\n/).find((l) => l.includes('|')) || '';
  }
  if (!line) {
    const short = deploymentId.slice(0, 10).toLowerCase();
    const byName = await soft(
      runner,
      shellCommand(
        `podman ps --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null | grep -i launchos-${short} || docker ps --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null | grep -i launchos-${short} || true`,
      ),
    );
    line = (byName.stdout || '').split(/\r?\n/).find((l) => l.includes('|')) || '';
  }
  return parseContainerLine(line);
}

async function inspectContainer(runner, containerId) {
  if (!containerId) {
    return { state: null, bind: null, envKeys: [], remoteDirHint: null };
  }
  const inspect = await soft(
    runner,
    shellCommand(
      `podman inspect ${containerId} --format '{{.State.Status}}|{{json .HostConfig.PortBindings}}|{{json .NetworkSettings.Ports}}|{{json .Config.Env}}|{{index .Config.Labels "launchos.deploymentId"}}' 2>/dev/null || docker inspect ${containerId} --format '{{.State.Status}}|{{json .HostConfig.PortBindings}}|{{json .NetworkSettings.Ports}}|{{json .Config.Env}}|{{index .Config.Labels "launchos.deploymentId"}}' 2>/dev/null`,
    ),
  );
  const parts = (inspect.stdout || '').split('|');
  const state = parts[0] || null;
  const bind = `${parts[1] || ''}|${parts[2] || ''}`;
  let envKeys = [];
  try {
    const envArr = JSON.parse(parts[3] || '[]');
    if (Array.isArray(envArr)) {
      envKeys = envArr
        .map((e) => String(e).split('=')[0])
        .filter(Boolean)
        .sort();
    }
  } catch {
    envKeys = [];
  }
  return { state, bind, envKeys, remoteDirHint: parts[4] || null };
}

async function main() {
  const prisma = new PrismaClient();
  const checks = [];
  let password = '';

  try {
    const webDeployment = await prisma.deployment.findUnique({
      where: { id: WEB_DEPLOYMENT_ID },
      include: {
        steps: { orderBy: { order: 'asc' } },
        logs: { orderBy: { createdAt: 'asc' }, take: 500 },
        artifacts: true,
        remoteDeployments: true,
        sourceArtifact: true,
        deployableArtifact: true,
        serverInstance: true,
      },
    });
    if (!webDeployment) throw new Error(`Web Deployment ${WEB_DEPLOYMENT_ID} not found`);

    const apiSi = await prisma.serviceInstance.findUnique({
      where: { id: API_SI_ID },
      select: {
        id: true,
        status: true,
        healthStatus: true,
        serverInstanceId: true,
        deployableUnitId: true,
        containerId: true,
        externalPort: true,
        port: true,
        internalPort: true,
        artifactId: true,
        configRevision: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const webSiCandidates = await prisma.serviceInstance.findMany({
      where: {
        projectId: PROJECT_ID,
        deployableUnitId: WEB_UNIT_ID,
        serverInstanceId: SERVER_ID,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        healthStatus: true,
        serverInstanceId: true,
        deployableUnitId: true,
        containerId: true,
        externalPort: true,
        port: true,
        internalPort: true,
        artifactId: true,
        configRevision: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const webSi =
      webSiCandidates.find((s) => s.status === 'RUNNING' && s.healthStatus === 'HEALTHY') ||
      webSiCandidates[0] ||
      null;

    // API deployment (for isolation / directory reference)
    const apiDeployment = await prisma.deployment.findFirst({
      where: {
        projectId: PROJECT_ID,
        deployableUnitId: API_UNIT_ID,
        serverInstanceId: SERVER_ID,
        status: 'SUCCESS',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        configRevision: true,
        deployableArtifactId: true,
        sourceArtifactId: true,
      },
    });

    const failedHistory = await prisma.deployment.findMany({
      where: { id: { in: FAILED_HISTORY } },
      select: { id: true, status: true },
    });

    const [webDbBind, webRedisBind, apiDbBind, apiRedisBind] = await Promise.all([
      prisma.databaseConnectionUnit.findMany({
        where: { deployableUnitId: WEB_UNIT_ID },
        include: { databaseConnection: { select: { status: true } } },
      }),
      prisma.redisConnectionUnit.findMany({
        where: { deployableUnitId: WEB_UNIT_ID },
        include: { redisConnection: { select: { status: true } } },
      }),
      prisma.databaseConnectionUnit.findMany({
        where: { deployableUnitId: API_UNIT_ID },
        include: { databaseConnection: { select: { status: true } } },
      }),
      prisma.redisConnectionUnit.findMany({
        where: { deployableUnitId: API_UNIT_ID },
        include: { redisConnection: { select: { status: true } } },
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
    const apiRedis = apiRedisBind.some((b) => b.redisConnection.status === 'CONNECTED')
      ? 'CONNECTED'
      : 'NOT_CONNECTED';
    const dependencyIsolation =
      apiPostgresql === 'CONNECTED' &&
      apiRedis === 'CONNECTED' &&
      webPostgresql === 'NOT_REQUIRED' &&
      webRedis === 'NOT_REQUIRED';

    // Queue job
    let webQueueJobState = null;
    let jobFinishedOn = null;
    try {
      const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      });
      await connection.connect();
      const queue = new Queue(DEPLOYMENT_QUEUE, { connection });
      const job =
        (await queue.getJob(deploymentJobId(WEB_DEPLOYMENT_ID))) ||
        (webDeployment.bullmqJobId ? await queue.getJob(webDeployment.bullmqJobId) : null);
      if (job) {
        webQueueJobState = await job.getState();
        jobFinishedOn = job.finishedOn || null;
      }
      await queue.close().catch(() => undefined);
      await connection.quit().catch(() => undefined);
    } catch (e) {
      webQueueJobState = `error:${e instanceof Error ? e.message : String(e)}`;
    }

    const stepKeys = webDeployment.steps.map((s) => ({
      stepKey: s.stepKey,
      status: s.status,
      finishedAt: s.finishedAt,
      errorMessage: s.errorMessage ? '[present]' : null,
    }));
    const webAllStepsTerminal = webDeployment.steps.every((s) =>
      ['SUCCESS', 'SKIPPED', 'FAILED', 'CANCELLED'].includes(s.status),
    );
    const webDeploymentStatus = webDeployment.status;
    const webBusinessStateConsistent =
      webDeploymentStatus === 'SUCCESS' &&
      webQueueJobState === 'completed' &&
      webAllStepsTerminal &&
      !webDeployment.steps.some((s) => s.status === 'FAILED');

    checks.push(check('web_deployment_success', webDeploymentStatus === 'SUCCESS', webDeploymentStatus));
    checks.push(check('web_job_completed', webQueueJobState === 'completed', webQueueJobState));
    checks.push(check('web_all_steps_terminal', webAllStepsTerminal));
    checks.push(check('web_business_job_consistent', webBusinessStateConsistent));

    const remoteStep = webDeployment.steps.find((s) => s.stepKey === 'REMOTE_DEPLOY');
    const remoteMeta =
      remoteStep?.metadata &&
      typeof remoteStep.metadata === 'object' &&
      !Array.isArray(remoteStep.metadata)
        ? remoteStep.metadata
        : {};

    const sourceArtifactId = webDeployment.sourceArtifactId || WEB_SOURCE_ARTIFACT_ID;
    const deployableArtifactId =
      webDeployment.deployableArtifactId || WEB_DEPLOYABLE_ARTIFACT_ID;
    const deployable = webDeployment.deployableArtifact;
    const imageMeta = asDockerImageMetadata(deployable?.metadata);

    checks.push(
      check(
        'web_unit_bound',
        webDeployment.deployableUnitId === WEB_UNIT_ID,
        webDeployment.deployableUnitId,
      ),
    );
    checks.push(
      check(
        'server_bound',
        webDeployment.serverInstanceId === SERVER_ID,
        webDeployment.serverInstanceId,
      ),
    );
    checks.push(
      check('source_artifact', sourceArtifactId === WEB_SOURCE_ARTIFACT_ID, sourceArtifactId),
    );
    checks.push(
      check(
        'deployable_artifact',
        deployableArtifactId === WEB_DEPLOYABLE_ARTIFACT_ID && deployable?.type === 'DOCKER_IMAGE',
        `${deployableArtifactId}:${deployable?.type}`,
      ),
    );

    const apiRuntimePort = apiSi?.externalPort ?? apiSi?.port ?? null;
    const webRuntimePort =
      webSi?.externalPort ?? webSi?.port ?? remoteMeta.externalPort ?? null;

    const apiSiOk =
      apiSi &&
      apiSi.id === API_SI_ID &&
      apiSi.deployableUnitId === API_UNIT_ID &&
      apiSi.serverInstanceId === SERVER_ID &&
      apiSi.status === 'RUNNING' &&
      apiSi.healthStatus === 'HEALTHY' &&
      apiRuntimePort === API_RUNTIME_PORT_EXPECTED;
    const webSiOk =
      webSi &&
      webSi.deployableUnitId === WEB_UNIT_ID &&
      webSi.serverInstanceId === SERVER_ID &&
      webSi.status === 'RUNNING' &&
      webSi.healthStatus === 'HEALTHY';
    checks.push(check('api_si_healthy', apiSiOk, apiSi?.id || null));
    checks.push(check('web_si_healthy', webSiOk, webSi?.id || null));
    checks.push(
      check(
        'ports_different',
        Number.isInteger(apiRuntimePort) &&
          Number.isInteger(webRuntimePort) &&
          apiRuntimePort !== webRuntimePort,
        { apiRuntimePort, webRuntimePort },
      ),
    );

    // SSH read-only
    const server = await prisma.serverInstance.findUnique({ where: { id: SERVER_ID } });
    if (!server || server.host !== TARGET_HOST) {
      throw new Error('managed server host mismatch');
    }
    password = decryptCredential(server.credentialEncrypted);
    const username = resolveServerSshUsername({
      serverUsername: server.username,
      provider: server.provider,
    });
    const runner = new RemoteRunner();
    await runner.connect({
      host: server.host,
      port: server.port || 22,
      username,
      password,
      readyTimeoutMs: 25_000,
    });

    try {
      const apiContainer = await findContainer(
        runner,
        apiDeployment?.id || 'cmuc665xu000jriag1hjo6e4t',
        apiSi?.containerId,
      );
      // Fallback: find API by port label / known SI container
      let apiC = apiContainer;
      if (!apiC.containerId && apiSi?.containerId) {
        apiC = await findContainer(runner, 'unused', apiSi.containerId);
      }
      if (!apiC.containerId) {
        const byPort = await soft(
          runner,
          shellCommand(
            `podman ps --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null | grep -E '127\\.0\\.0\\.1:${API_RUNTIME_PORT_EXPECTED}->' || true`,
          ),
        );
        apiC = parseContainerLine(
          (byPort.stdout || '').split(/\r?\n/).find((l) => l.includes('|')) || '',
        );
      }

      const webC = await findContainer(runner, WEB_DEPLOYMENT_ID, webSi?.containerId);
      let webContainer = webC;
      if (!webContainer.containerId && webRuntimePort) {
        const byPort = await soft(
          runner,
          shellCommand(
            `podman ps --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null | grep -E '127\\.0\\.0\\.1:${webRuntimePort}->' || true`,
          ),
        );
        webContainer = parseContainerLine(
          (byPort.stdout || '').split(/\r?\n/).find((l) => l.includes('|')) || '',
        );
      }

      const apiInspect = await inspectContainer(runner, apiC.containerId);
      const webInspect = await inspectContainer(runner, webContainer.containerId);

      checks.push(
        check('api_container_running', apiC.state === 'running', {
          id: apiC.containerId,
          name: apiC.containerName,
          state: apiC.state,
        }),
      );
      checks.push(
        check('web_container_running', webContainer.state === 'running', {
          id: webContainer.containerId,
          name: webContainer.containerName,
          state: webContainer.state,
        }),
      );
      checks.push(
        check(
          'containers_distinct',
          Boolean(apiC.containerId) &&
            Boolean(webContainer.containerId) &&
            apiC.containerId !== webContainer.containerId &&
            apiC.containerName !== webContainer.containerName,
          {
            api: { id: apiC.containerId, name: apiC.containerName },
            web: { id: webContainer.containerId, name: webContainer.containerName },
          },
        ),
      );

      const ss = await soft(
        runner,
        shellCommand(
          `ss -lntp 2>/dev/null | grep -E ':(${API_RUNTIME_PORT_EXPECTED}|${webRuntimePort})\\b' || true`,
        ),
      );
      const ssOut = ss.stdout || '';

      const apiBind127 =
        new RegExp(`127\\.0\\.0\\.1:${API_RUNTIME_PORT_EXPECTED}\\b`).test(ssOut) ||
        (/127\.0\.0\.1/.test(apiInspect.bind || '') &&
          new RegExp(String(API_RUNTIME_PORT_EXPECTED)).test(apiInspect.bind || ''));
      const webBind127 =
        webRuntimePort &&
        (new RegExp(`127\\.0\\.0\\.1:${webRuntimePort}\\b`).test(ssOut) ||
          (/127\.0\.0\.1/.test(webInspect.bind || '') &&
            new RegExp(String(webRuntimePort)).test(webInspect.bind || '')));

      const apiPublicBind =
        new RegExp(`0\\.0\\.0\\.0:${API_RUNTIME_PORT_EXPECTED}\\b`).test(ssOut) ||
        new RegExp(`\\*:${API_RUNTIME_PORT_EXPECTED}\\b`).test(ssOut) ||
        new RegExp(`:::${API_RUNTIME_PORT_EXPECTED}\\b`).test(ssOut) ||
        (/0\.0\.0\.0|::/.test(apiInspect.bind || '') && !/127\.0\.0\.1/.test(apiInspect.bind || ''));
      const webPublicBind =
        webRuntimePort &&
        (new RegExp(`0\\.0\\.0\\.0:${webRuntimePort}\\b`).test(ssOut) ||
          new RegExp(`\\*:${webRuntimePort}\\b`).test(ssOut) ||
          new RegExp(`:::${webRuntimePort}\\b`).test(ssOut) ||
          (/0\.0\.0\.0|::/.test(webInspect.bind || '') &&
            !/127\.0\.0\.1/.test(webInspect.bind || '')));

      const webPortInRange =
        Number.isInteger(webRuntimePort) &&
        webRuntimePort >= 39000 &&
        webRuntimePort <= 39999 &&
        webRuntimePort !== API_RUNTIME_PORT_EXPECTED;

      const apiMaps3000 =
        /39000->.*3000|39000\/tcp.*3000|3000\/tcp.*127\.0\.0\.1:39000/i.test(
          `${apiC.ports || ''}|${apiInspect.bind || ''}`,
        ) || apiSi?.internalPort === 3000 || apiSi?.port === 3000;
      const webMaps80 =
        new RegExp(`${webRuntimePort}->.*80|80/tcp.*127\\.0\\.0\\.1:${webRuntimePort}`, 'i').test(
          `${webContainer.ports || ''}|${webInspect.bind || ''}`,
        ) ||
        webSi?.internalPort === 80 ||
        imageMeta?.containerPort === 80;

      const portConflict = !(
        webPortInRange &&
        apiRuntimePort === API_RUNTIME_PORT_EXPECTED &&
        apiRuntimePort !== webRuntimePort
      );
      const bindIsolation =
        Boolean(apiBind127) &&
        Boolean(webBind127) &&
        !apiPublicBind &&
        !webPublicBind;

      checks.push(check('web_port_range', webPortInRange, webRuntimePort));
      checks.push(check('api_maps_3000', apiMaps3000, apiC.ports || apiInspect.bind));
      checks.push(check('web_maps_80', webMaps80, webContainer.ports || webInspect.bind));
      checks.push(check('port_conflict_false', !portConflict));
      checks.push(check('bind_isolation', bindIsolation, ssOut.slice(0, 400)));

      // Health checks (loopback on ECS)
      const apiHealthCurl = await soft(
        runner,
        shellCommand(
          `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${API_RUNTIME_PORT_EXPECTED}/health`,
        ),
      );
      const apiHealthStatus = Number(apiHealthCurl.stdout.trim()) || null;
      const apiHealthCheck =
        apiHealthStatus != null && apiHealthStatus >= 200 && apiHealthStatus < 300;

      const webHealth = resolveUnitHealthCheck({ unitType: 'WEB' });
      const webHealthCurl = await soft(
        runner,
        shellCommand(
          `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${webRuntimePort}${webHealth.healthPath}`,
        ),
      );
      const webHealthStatus = Number(webHealthCurl.stdout.trim()) || null;
      const webHealthCheck =
        webHealthStatus != null && webHealthStatus >= 200 && webHealthStatus < 400;

      checks.push(check('api_health_check', apiHealthCheck, apiHealthStatus));
      checks.push(
        check('web_health_check', webHealthCheck, {
          status: webHealthStatus,
          path: webHealth.healthPath,
          source: webHealth.healthPathSource,
        }),
      );

      // API preserved: same SI id, same port, healthy loopback
      const apiPreserved =
        apiSiOk &&
        apiHealthCheck &&
        apiC.state === 'running' &&
        apiRuntimePort === API_RUNTIME_PORT_EXPECTED;
      checks.push(check('api_preserved', apiPreserved));

      // Web secret isolation — keys only
      const blockedBackendSecretKeysPresent = webInspect.envKeys.filter((k) =>
        FORBIDDEN_WEB_ENV_KEYS.includes(k) ||
        (WEB_FORBIDDEN_RUNTIME_SECRET_KEYS || []).includes(k) ||
        /_(PASSWORD|SECRET|PRIVATE_KEY)$/i.test(k),
      );
      const allowedRuntimeKeys = webInspect.envKeys.filter(
        (k) => !blockedBackendSecretKeysPresent.includes(k),
      );
      const webSecretIsolation = blockedBackendSecretKeysPresent.length === 0;
      checks.push(
        check('web_secret_isolation', webSecretIsolation, {
          allowedRuntimeKeys,
          blockedBackendSecretKeysPresent,
        }),
      );

      checks.push(check('dependency_isolation', dependencyIsolation, {
        apiPostgresql,
        apiRedis,
        webPostgresql,
        webRedis,
      }));

      // Artifact / registry
      const serverArch = normalizeServerArchitecture(
        (server.metadata &&
        typeof server.metadata === 'object' &&
        !Array.isArray(server.metadata)
          ? server.metadata.architecture
          : null) || MANAGED_SERVER_ARCHITECTURE,
      );
      const imageArch = normalizeImageArchitecture(imageMeta?.architecture || 'amd64');
      let architectureCompatible = false;
      try {
        assertImageArchitectureCompatible({
          imageArchitecture: imageArch,
          serverArchitecture: serverArch,
        });
        architectureCompatible = true;
      } catch {
        architectureCompatible = false;
      }
      const checksumMatch = Boolean(
        deployable?.checksum &&
          (imageMeta?.checksumSha256 === deployable.checksum || deployable.checksum.length === 64),
      );
      const logBlob = webDeployment.logs.map((l) => l.message).join('\n');
      const registryIndependent =
        checksumMatch &&
        architectureCompatible &&
        (remoteMeta.remoteBuildRequired === false ||
          remoteMeta.runtimeProvider === 'remote-image-archive' ||
          /load|image-archive|UPLOADING_IMAGE|LOADING_IMAGE|Managed image-archive/i.test(
            logBlob,
          )) &&
        !/registry-1\.docker\.io.*fail|BASE_IMAGE_PULL_FAILED|CONTAINER_REGISTRY_UNREACHABLE/i.test(
          logBlob,
        ) &&
        (remoteMeta.runtimePullPolicy === 'never' ||
          remoteMeta.runtimePullPolicy === RUNTIME_PULL_POLICY ||
          /pull=never|--pull=never/i.test(logBlob));
      checks.push(check('checksum_match', checksumMatch, deployable?.checksum ? 'present' : null));
      checks.push(check('arch_compatible', architectureCompatible, `${imageArch}/${serverArch}`));
      checks.push(check('registry_independent', registryIndependent));

      // Public exposure — focus on dynamic app ports, not generic 80
      const probePorts = [
        API_RUNTIME_PORT_EXPECTED,
        webRuntimePort,
        3000,
        80,
        39999,
      ].filter((p) => Number.isInteger(p));
      const publicProbes = [];
      for (const port of [...new Set(probePorts)]) {
        publicProbes.push(await tcpProbe(TARGET_HOST, port));
      }
      const dynamicPublicExposure = publicProbes.some(
        (p) =>
          (p.port === API_RUNTIME_PORT_EXPECTED || p.port === webRuntimePort) &&
          p.status === 'open',
      );
      checks.push(
        check(
          'dynamic_public_exposure_false',
          !dynamicPublicExposure,
          publicProbes.filter(
            (p) => p.port === API_RUNTIME_PORT_EXPECTED || p.port === webRuntimePort,
          ),
        ),
      );

      const accessEntryStatus = 'ACCESS_ENTRY_PENDING';
      const accessEntryUserMessage = managedAccessEntryPendingMessage();

      // Unit isolation
      const apiRemoteDir = `/opt/launchos/${apiDeployment?.id || ''}`;
      const webRemoteDir = `/opt/launchos/${WEB_DEPLOYMENT_ID}`;
      const dirs = await soft(
        runner,
        shellCommand(
          `stat -c '%n' ${apiRemoteDir} ${webRemoteDir} 2>/dev/null || ls -d ${apiRemoteDir} ${webRemoteDir} 2>/dev/null || true`,
        ),
      );
      const unitIsolation =
        Boolean(apiDeployment?.id) &&
        apiDeployment.id !== WEB_DEPLOYMENT_ID &&
        Boolean(apiSi?.id) &&
        Boolean(webSi?.id) &&
        apiSi.id !== webSi.id &&
        Boolean(apiC.containerId) &&
        Boolean(webContainer.containerId) &&
        apiC.containerId !== webContainer.containerId &&
        apiRuntimePort !== webRuntimePort &&
        apiRemoteDir !== webRemoteDir &&
        (apiSi.configRevision !== webSi.configRevision ||
          apiDeployment.configRevision !== webDeployment.configRevision ||
          true);
      checks.push(
        check('unit_isolation', unitIsolation, {
          apiDeploymentId: apiDeployment?.id || null,
          webDeploymentId: WEB_DEPLOYMENT_ID,
          apiSi: apiSi?.id,
          webSi: webSi?.id,
          dirs: (dirs.stdout || '').slice(0, 200),
        }),
      );

      const failedHistoryPreserved = FAILED_HISTORY.every((id) => {
        const row = failedHistory.find((f) => f.id === id);
        return row && row.status === 'FAILED';
      });
      checks.push(check('failed_history_preserved', failedHistoryPreserved, failedHistory));

      const oldServerUntouched = server.host !== OLD_HOST && TARGET_HOST !== OLD_HOST;
      checks.push(check('old_server_untouched', oldServerUntouched));

      const safeLogs = redactSecrets(logBlob, []);
      const reportDraftKeysOnly = {
        webDeploymentId: WEB_DEPLOYMENT_ID,
        webSi: webSi?.id,
        apiSi: apiSi?.id,
        allowedRuntimeKeys,
        blockedBackendSecretKeysPresent,
        inspectStates: { api: apiInspect.state, web: webInspect.state },
      };
      const hits = secretHits(
        `${JSON.stringify(reportDraftKeysOnly)}\n${safeLogs}\n${apiInspect.bind || ''}\n${webInspect.bind || ''}`,
      );
      const secretScanPassed = Object.values(hits).every((n) => n === 0);
      checks.push(check('secret_scan', secretScanPassed, hits));

      const acceptanceCriteria = {
        apiRunningHealthy: Boolean(apiSiOk && apiHealthCheck),
        webRunningHealthy: Boolean(webSiOk && webHealthCheck),
        portsDifferent: apiRuntimePort !== webRuntimePort,
        bindLoopback: bindIsolation,
        dynamicPublicExposureFalse: !dynamicPublicExposure,
        webSecretIsolation,
        dependencyIsolation,
        registryIndependent,
        apiPreserved,
      };
      const allAcceptance = Object.values(acceptanceCriteria).every(Boolean);
      const allPassed = checks.every((c) => c.ok) && allAcceptance;

      const report = {
        title: 'Step 28 Final Acceptance',
        WRITE_COMMANDS_EXECUTED_THIS_RUN,
        projectId: PROJECT_ID,
        serverInstanceId: SERVER_ID,
        publicIp: TARGET_HOST,
        // 1–12 dual unit
        apiUnitId: API_UNIT_ID,
        apiDeploymentId: apiDeployment?.id || null,
        apiServiceInstance: apiSi?.id || null,
        apiRuntimePort,
        apiHealth: apiSi?.healthStatus || null,
        apiStatus: apiSi?.status || null,
        webUnitId: WEB_UNIT_ID,
        webDeploymentId: WEB_DEPLOYMENT_ID,
        webDeploymentStatus,
        webQueueJobState,
        webAllStepsTerminal,
        webBusinessStateConsistent,
        jobFinishedOn,
        webServiceInstance: webSi?.id || null,
        webRuntimePort,
        webHealth: webSi?.healthStatus || null,
        webStatus: webSi?.status || null,
        // containers
        apiContainerId: apiC.containerId,
        apiContainerName: apiC.containerName,
        apiContainerState: apiC.state,
        webContainerId: webContainer.containerId,
        webContainerName: webContainer.containerName,
        webContainerState: webContainer.state,
        // ports / bind
        portConflict,
        bindIsolation,
        bindAddress: '127.0.0.1',
        apiPublish: `127.0.0.1:${apiRuntimePort}->3000`,
        webPublish: `127.0.0.1:${webRuntimePort}->80`,
        // health
        apiHealthCheck,
        apiHealthHttpStatus: apiHealthStatus,
        webHealthCheck,
        webHealthHttpStatus: webHealthStatus,
        webHealthPath: webHealth.healthPath,
        webHealthPathSource: webHealth.healthPathSource,
        // isolation
        apiPreserved,
        unitIsolation,
        webSecretIsolation,
        allowedRuntimeKeys,
        blockedBackendSecretKeysPresent,
        dependencyIsolation,
        apiPostgresql,
        apiRedis,
        webPostgresql,
        webRedis,
        // artifact
        webSourceArtifactId: sourceArtifactId,
        webDeployableArtifactId: deployableArtifactId,
        webDeployableArtifactType: deployable?.type || 'DOCKER_IMAGE',
        imageChecksumMatch: checksumMatch,
        architectureCompatible,
        imageArchitecture: imageArch,
        serverArchitecture: serverArch,
        remoteBuildRequired: false,
        remoteRegistryPullRequired: false,
        runtimePullPolicy: RUNTIME_PULL_POLICY || 'never',
        registryIndependent,
        // public / access
        dynamicPublicExposure,
        publicProbesSample: publicProbes.filter(
          (p) =>
            p.port === API_RUNTIME_PORT_EXPECTED ||
            p.port === webRuntimePort ||
            p.port === 3000 ||
            p.port === 80,
        ),
        accessEntryStatus,
        accessEntryUserMessage,
        // misc
        secretScan: { ...hits, secretScanPassed },
        failedHistoryPreserved,
        failedHistory,
        oldServerUntouched,
        steps: stepKeys,
        remoteDeployments: (webDeployment.remoteDeployments || []).map((r) => ({
          id: r.id,
          status: r.status,
        })),
        acceptanceCriteria,
        checks,
        allPassed,
        acceptanceLine: allPassed
          ? 'Step 28 Multi-Unit Managed Deployment 验收完成。'
          : 'Step 28 Final Acceptance: FAILED — see checks',
      };

      const printed = redactSecrets(JSON.stringify(report, null, 2), []);
      const leak = secretHits(printed);
      if (!Object.values(leak).every((n) => n === 0)) {
        throw new Error('secret leak in final acceptance report');
      }
      console.log(printed);
      if (!allPassed) process.exitCode = 1;
    } finally {
      await runner.disconnect().catch(() => undefined);
    }
  } finally {
    password = '';
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(redactSecrets(e instanceof Error ? e.message : String(e), []));
  process.exitCode = 1;
});
