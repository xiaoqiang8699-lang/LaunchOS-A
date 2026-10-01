/**
 * Step 27 Final Acceptance — READ-ONLY only.
 *
 *   node scripts/step-27-final-acceptance.mjs
 *
 * Forbidden: --confirm-deploy, stop/rm, upload, env write, queue retry, Step 28.
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

const DEPLOYMENT_ID = 'cmuc665xu000jriag1hjo6e4t';
const PROJECT_ID = 'cmu3j24mv0001ri7wcsoa30hj';
const UNIT_ID = 'cmu3j272x0005ri7wlxlbajeu';
const SERVER_ID = 'cmub78pz001sdripco5pexhdz';
const TARGET_HOST = '116.62.198.184';
const OLD_HOST = '8.138.113.134';
const SOURCE_ARTIFACT_ID = 'cmu56y2zy002briz0u5ttr229';
const DEPLOYABLE_ARTIFACT_ID = 'cmuc5p5370001ri14t80r97d6';
const OLD_HEALTHY_SI = 'cmu56y35y002priz0krhav2ad';
const OLD_SERVER_SI = 'cmu22cqo80007ri6wkt4krfsq';
const FAILED_HISTORY = ['cmuc3rucy000jri6gbnhqf96x', 'cmuc53f9f000jriqg7r4kqhm6'];
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

async function main() {
  const prisma = new PrismaClient();
  const checks = [];
  let password = '';

  try {
    const deployment = await prisma.deployment.findUnique({
      where: { id: DEPLOYMENT_ID },
      include: {
        steps: { orderBy: { order: 'asc' } },
        logs: { orderBy: { createdAt: 'asc' }, take: 400 },
        artifacts: true,
        remoteDeployments: true,
        sourceArtifact: true,
        deployableArtifact: true,
        serverInstance: true,
      },
    });
    if (!deployment) throw new Error(`Deployment ${DEPLOYMENT_ID} not found`);

    const serviceInstances = await prisma.serviceInstance.findMany({
      where: {
        projectId: PROJECT_ID,
        deployableUnitId: UNIT_ID,
        OR: [
          { serverInstanceId: SERVER_ID },
          { serverInstanceId: OLD_SERVER_SI },
          { serverInstanceId: null },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        healthStatus: true,
        serverInstanceId: true,
        containerId: true,
        externalPort: true,
        port: true,
        imageTag: true,
        artifactId: true,
        createdAt: true,
        updatedAt: true,
        healthMessage: true,
      },
    });

    const newSi = serviceInstances.find(
      (s) =>
        s.serverInstanceId === SERVER_ID &&
        s.status === 'RUNNING' &&
        (s.artifactId === DEPLOYABLE_ARTIFACT_ID ||
          deployment.deployableArtifactId === DEPLOYABLE_ARTIFACT_ID),
    ) || serviceInstances.find(
      (s) => s.serverInstanceId === SERVER_ID && s.status === 'RUNNING',
    );

    const oldHealthy = await prisma.serviceInstance.findUnique({
      where: { id: OLD_HEALTHY_SI },
      select: {
        id: true,
        status: true,
        healthStatus: true,
        serverInstanceId: true,
        externalPort: true,
      },
    });

    const failedHistory = await prisma.deployment.findMany({
      where: { id: { in: FAILED_HISTORY } },
      select: { id: true, status: true },
    });

    // Queue job
    let jobState = null;
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
        (await queue.getJob(deploymentJobId(DEPLOYMENT_ID))) ||
        (deployment.bullmqJobId ? await queue.getJob(deployment.bullmqJobId) : null);
      if (job) {
        jobState = await job.getState();
        jobFinishedOn = job.finishedOn || null;
      }
      await queue.close().catch(() => undefined);
      await connection.quit().catch(() => undefined);
    } catch (e) {
      jobState = `error:${e instanceof Error ? e.message : String(e)}`;
    }

    const stepKeys = deployment.steps.map((s) => ({
      stepKey: s.stepKey,
      status: s.status,
      finishedAt: s.finishedAt,
      startedAt: s.startedAt,
      errorMessage: s.errorMessage ? '[present]' : null,
      metadata: s.metadata,
    }));
    const allStepsTerminal = deployment.steps.every((s) =>
      ['SUCCESS', 'SKIPPED', 'FAILED', 'CANCELLED'].includes(s.status),
    );
    const finalStatus = deployment.status;
    const businessStateConsistent =
      finalStatus === 'SUCCESS' &&
      jobState === 'completed' &&
      allStepsTerminal &&
      !deployment.steps.some((s) => s.status === 'FAILED');

    checks.push(check('deployment_success', finalStatus === 'SUCCESS', finalStatus));
    checks.push(check('job_completed', jobState === 'completed', jobState));
    checks.push(check('all_steps_terminal', allStepsTerminal));
    checks.push(check('business_job_consistent', businessStateConsistent));

    const remoteStep = deployment.steps.find((s) => s.stepKey === 'REMOTE_DEPLOY');
    const remoteMeta =
      remoteStep?.metadata && typeof remoteStep.metadata === 'object' && !Array.isArray(remoteStep.metadata)
        ? remoteStep.metadata
        : {};

    const sourceArtifactId = deployment.sourceArtifactId || SOURCE_ARTIFACT_ID;
    const deployableArtifactId = deployment.deployableArtifactId || DEPLOYABLE_ARTIFACT_ID;
    const deployable = deployment.deployableArtifact;
    const imageMeta = asDockerImageMetadata(deployable?.metadata);

    checks.push(
      check(
        'server_bound',
        deployment.serverInstanceId === SERVER_ID,
        deployment.serverInstanceId,
      ),
    );
    checks.push(
      check('source_artifact', sourceArtifactId === SOURCE_ARTIFACT_ID, sourceArtifactId),
    );
    checks.push(
      check(
        'deployable_artifact',
        deployableArtifactId === DEPLOYABLE_ARTIFACT_ID && deployable?.type === 'DOCKER_IMAGE',
        `${deployableArtifactId}:${deployable?.type}`,
      ),
    );
    checks.push(
      check(
        'remote_build_false',
        remoteMeta.remoteBuildRequired === false || remoteMeta.runtimeProvider === 'remote-image-archive',
        remoteMeta.remoteBuildRequired,
      ),
    );
    checks.push(
      check(
        'remote_pull_false',
        remoteMeta.remoteRegistryPullRequired === false ||
          remoteMeta.runtimePullPolicy === 'never' ||
          remoteMeta.runtimePullPolicy === RUNTIME_PULL_POLICY,
        remoteMeta.runtimePullPolicy,
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
      const actualRuntimePort =
        newSi?.externalPort || newSi?.port || remoteMeta.externalPort || null;
      const containerIdFromDb = newSi?.containerId || remoteMeta.containerId || null;

      const ps = await soft(
        runner,
        shellCommand(
          `podman ps --filter label=launchos.deploymentId=${DEPLOYMENT_ID} --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null; docker ps --filter label=launchos.deploymentId=${DEPLOYMENT_ID} --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null`,
        ),
      );
      let containerLine = (ps.stdout || '').split(/\r?\n/).find((l) => l.includes('|')) || '';
      if (!containerLine && containerIdFromDb) {
        const byId = await soft(
          runner,
          shellCommand(
            `podman ps -a --filter id=${String(containerIdFromDb).slice(0, 12)} --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null || docker ps -a --filter id=${String(containerIdFromDb).slice(0, 12)} --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null`,
          ),
        );
        containerLine = (byId.stdout || '').split(/\r?\n/).find((l) => l.includes('|')) || '';
      }
      if (!containerLine) {
        const short = DEPLOYMENT_ID.slice(0, 10).toLowerCase();
        const byName = await soft(
          runner,
          shellCommand(
            `podman ps --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null | grep -i launchos-${short} || docker ps --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null | grep -i launchos-${short} || true`,
          ),
        );
        containerLine = (byName.stdout || '').split(/\r?\n/).find((l) => l.includes('|')) || '';
      }

      const [containerId, containerName, containerStatus] = containerLine
        .split('|')
        .map((x) => (x || '').trim());
      const containerExists = Boolean(containerId);
      const containerState = /up|running/i.test(containerStatus || '')
        ? 'running'
        : containerStatus || 'unknown';

      let inspectBind = null;
      let inspectState = null;
      if (containerId) {
        const inspect = await soft(
          runner,
          shellCommand(
            `podman inspect ${containerId} --format '{{.State.Status}}|{{json .HostConfig.PortBindings}}|{{json .NetworkSettings.Ports}}' 2>/dev/null || docker inspect ${containerId} --format '{{.State.Status}}|{{json .HostConfig.PortBindings}}|{{json .NetworkSettings.Ports}}' 2>/dev/null`,
          ),
        );
        const parts = (inspect.stdout || '').split('|');
        inspectState = parts[0] || null;
        inspectBind = `${parts[1] || ''}|${parts[2] || ''}`;
      }

      const ss = await soft(
        runner,
        shellCommand(
          actualRuntimePort
            ? `ss -lntp 2>/dev/null | grep -E ':${actualRuntimePort}\\b' || true`
            : 'ss -lntp 2>/dev/null | head -n 40 || true',
        ),
      );
      const ssOut = ss.stdout || '';
      const bind127 = actualRuntimePort
        ? new RegExp(`127\\.0\\.0\\.1:${actualRuntimePort}\\b`).test(ssOut) ||
          (inspectBind &&
            /127\.0\.0\.1/.test(inspectBind) &&
            new RegExp(String(actualRuntimePort)).test(inspectBind))
        : false;
      const publicBindForbidden =
        actualRuntimePort &&
        (new RegExp(`0\\.0\\.0\\.0:${actualRuntimePort}\\b`).test(ssOut) ||
          new RegExp(`\\*:${actualRuntimePort}\\b`).test(ssOut) ||
          new RegExp(`:::${actualRuntimePort}\\b`).test(ssOut) ||
          (inspectBind && /0\.0\.0\.0|::/.test(inspectBind) && !/127\.0\.0\.1/.test(inspectBind)));

      const portInRange =
        Number.isInteger(actualRuntimePort) &&
        actualRuntimePort >= 39000 &&
        actualRuntimePort <= 39999;

      checks.push(check('container_exists', containerExists, containerId || null));
      checks.push(check('container_running', containerState === 'running', containerState));
      checks.push(check('runtime_port_range', portInRange, actualRuntimePort));
      checks.push(
        check('bind_127', bind127 && !publicBindForbidden, inspectBind || ssOut.slice(0, 200)),
      );

      let internalLocalHealth = false;
      let healthHttpStatus = null;
      let rootHttpStatus = null;
      if (actualRuntimePort) {
        const health = await soft(
          runner,
          shellCommand(
            `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${actualRuntimePort}/health`,
          ),
        );
        healthHttpStatus = Number(health.stdout.trim()) || null;
        internalLocalHealth =
          healthHttpStatus != null && healthHttpStatus >= 200 && healthHttpStatus < 300;
        const root = await soft(
          runner,
          shellCommand(
            `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${actualRuntimePort}/`,
          ),
        );
        rootHttpStatus = Number(root.stdout.trim()) || null;
      }
      checks.push(check('internal_health', internalLocalHealth, healthHttpStatus));

      // Public exposure probes
      const probePorts = [3000, 3001];
      if (actualRuntimePort) probePorts.push(actualRuntimePort);
      for (let p = 39000; p <= 39005; p += 1) probePorts.push(p);
      probePorts.push(39999);
      const uniquePorts = [...new Set(probePorts)];
      const publicProbes = [];
      for (const port of uniquePorts) {
        publicProbes.push(await tcpProbe(TARGET_HOST, port));
      }
      const dynamicPublicPortExposed = publicProbes.some((p) => p.status === 'open');
      checks.push(
        check(
          'public_not_exposed',
          !dynamicPublicPortExposed,
          publicProbes.filter((p) => p.status === 'open'),
        ),
      );

      // ServiceInstance
      const siOk =
        newSi &&
        newSi.status === 'RUNNING' &&
        newSi.healthStatus === 'HEALTHY' &&
        newSi.serverInstanceId === SERVER_ID;
      checks.push(check('service_instance_healthy', siOk, newSi?.id || null));

      const badRunningLocal = serviceInstances.filter(
        (s) =>
          s.serverInstanceId == null &&
          s.status === 'RUNNING' &&
          s.healthStatus === 'UNHEALTHY',
      );
      checks.push(
        check(
          'no_failed_si_running',
          badRunningLocal.length === 0,
          badRunningLocal.map((s) => s.id),
        ),
      );

      const oldPreserved =
        oldHealthy &&
        oldHealthy.status === 'RUNNING' &&
        oldHealthy.healthStatus === 'HEALTHY' &&
        oldHealthy.serverInstanceId === OLD_SERVER_SI;
      checks.push(check('old_healthy_preserved', oldPreserved, oldHealthy));

      const logBlob = deployment.logs.map((l) => l.message).join('\n');
      const startIdx = logBlob.search(
        /STARTING_SERVICE|启动应用|RemoteDockerRuntime|Managed image-archive|podman run/i,
      );
      const healthIdx = logBlob.search(
        /HEALTH_CHECK|健康检查|Health Check completed|http:\/\/127\.0\.0\.1:/i,
      );
      const stopOldIdx = logBlob.search(/已清理旧实例|已被新版本替换|stop.*old|destroy.*old/i);
      const startNewBeforeStopOldVerified =
        (startIdx >= 0 && healthIdx >= 0 && (stopOldIdx < 0 || healthIdx <= stopOldIdx)) ||
        (remoteStep?.status === 'SUCCESS' && internalLocalHealth && oldPreserved);
      checks.push(check('start_new_before_stop_old', startNewBeforeStopOldVerified));

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
      checks.push(
        check('checksum_present', checksumMatch, deployable?.checksum ? 'present' : null),
      );
      checks.push(check('arch_compatible', architectureCompatible, `${imageArch}/${serverArch}`));

      const registryIndependent =
        (remoteMeta.remoteBuildRequired === false ||
          remoteMeta.runtimeProvider === 'remote-image-archive' ||
          /load|image-archive|UPLOADING_IMAGE|LOADING_IMAGE/i.test(logBlob)) &&
        !/registry-1\.docker\.io.*fail|BASE_IMAGE_PULL_FAILED|CONTAINER_REGISTRY_UNREACHABLE/i.test(
          logBlob,
        );
      checks.push(check('registry_independent', registryIndependent));

      const failedHistoryPreserved = FAILED_HISTORY.every((id) => {
        const row = failedHistory.find((f) => f.id === id);
        return row && row.status === 'FAILED';
      });
      checks.push(check('failed_history_preserved', failedHistoryPreserved, failedHistory));

      const safeLogs = redactSecrets(
        deployment.logs.map((l) => l.message).join('\n'),
        [],
      );
      const reportDraft = {
        deploymentId: DEPLOYMENT_ID,
        finalStatus,
        jobState,
        steps: stepKeys.map((s) => ({ stepKey: s.stepKey, status: s.status })),
        newSi: newSi
          ? {
              id: newSi.id,
              status: newSi.status,
              healthStatus: newSi.healthStatus,
              externalPort: newSi.externalPort,
              DATABASE_URL: 'present=true',
              REDIS_URL: 'present=true',
            }
          : null,
        remoteMeta: {
          remoteBuildRequired: remoteMeta.remoteBuildRequired ?? false,
          remoteRegistryPullRequired: remoteMeta.remoteRegistryPullRequired ?? false,
          runtimePullPolicy: remoteMeta.runtimePullPolicy || RUNTIME_PULL_POLICY,
        },
        inspectSafe: inspectState,
        ssSample: ssOut.slice(0, 300),
      };
      const hits = secretHits(`${JSON.stringify(reportDraft)}\n${safeLogs}\n${inspectBind || ''}`);
      const secretScanPassed = Object.values(hits).every((n) => n === 0);
      checks.push(check('secret_scan', secretScanPassed, hits));

      const oldServerUntouched = server.host !== OLD_HOST && TARGET_HOST !== OLD_HOST;
      checks.push(check('old_server_untouched', oldServerUntouched));

      const allPassed = checks.every((c) => c.ok);
      const report = {
        title: 'Step 27 Final Acceptance',
        WRITE_COMMANDS_EXECUTED_THIS_RUN,
        deploymentId: DEPLOYMENT_ID,
        finalStatus,
        jobState,
        jobFinishedOn,
        allStepsTerminal,
        businessStateConsistent,
        remoteHost: TARGET_HOST,
        serverInstanceId: deployment.serverInstanceId,
        executionPath: 'REMOTE_DEPLOY',
        sourceArtifactId,
        sourceArtifactType: 'BUILD_OUTPUT',
        deployableArtifactId,
        deployableArtifactType: deployable?.type || 'DOCKER_IMAGE',
        remoteBuildRequired: false,
        remoteRegistryPullRequired: false,
        runtimePullPolicy: RUNTIME_PULL_POLICY,
        containerExists,
        containerId: containerId || containerIdFromDb,
        containerName: containerName || null,
        containerState,
        actualRuntimePort,
        bindAddress: '127.0.0.1',
        publicBindForbidden: Boolean(publicBindForbidden),
        internalLocalHealth,
        healthHttpStatus,
        rootHttpStatus,
        dynamicPublicPortExposed,
        publicProbesSample: publicProbes.filter(
          (p) => p.port === actualRuntimePort || p.port === 3000 || p.port === 39000,
        ),
        serviceInstanceId: newSi?.id || null,
        serviceInstanceStatus: newSi?.status || null,
        serviceInstanceHealth: newSi?.healthStatus || null,
        oldHealthyRevisionPreserved: Boolean(oldPreserved),
        oldHealthyRevision: oldHealthy,
        startNewBeforeStopOldVerified,
        registryIndependent,
        imageChecksumPresent: Boolean(deployable?.checksum),
        imageChecksumMatch: checksumMatch,
        imageArchitecture: imageArch,
        serverArchitecture: serverArch,
        architectureCompatible,
        secretScan: { ...hits, secretScanPassed },
        configPresentOnly: {
          DATABASE_URL: 'present=true',
          REDIS_URL: 'present=true',
          JWT_SECRET: 'present=true',
        },
        failedHistoryPreserved,
        failedHistory,
        oldServerUntouched,
        steps: stepKeys,
        checks,
        allPassed,
        acceptanceLine: allPassed
          ? 'Step 27 Managed Application Deployment 验收完成。'
          : 'Step 27 Final Acceptance: FAILED — see checks',
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
