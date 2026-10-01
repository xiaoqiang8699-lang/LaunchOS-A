/**
 * Step 27 — read-only diagnosis for failed managed deployment.
 * Never: --confirm-deploy / podman start|stop|rm / upload / enqueue.
 *
 *   node scripts/step-27-diagnose-deployment.mjs --deployment-id=cmuc3rucy000jri6gbnhqf96x
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

const DEPLOYMENT_ID =
  argValue('--deployment-id') || process.env.E2E_DEPLOYMENT_ID || 'cmuc3rucy000jri6gbnhqf96x';
const TARGET_HOST = '116.62.198.184';
const OLD_HOST = '8.138.113.134';
const EXPECTED_SI = 'cmub78pz001sdripco5pexhdz';
const EXPECTED_ARTIFACT = 'cmu56y2zy002briz0u5ttr229';
const WRITE_COMMANDS_EXECUTED_THIS_RUN = false;

function argValue(flag) {
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i].startsWith(`${flag}=`)) return process.argv[i].slice(flag.length + 1);
    if (process.argv[i] === flag) return process.argv[i + 1];
  }
  return null;
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  redactSecrets,
  deploymentJobId,
  DEPLOYMENT_QUEUE,
  shellCommand,
} = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { Queue } = requireApi('bullmq');
const IORedis = requireApi('ioredis');

function assertNoSecret(blob, label) {
  const text = typeof blob === 'string' ? blob : JSON.stringify(blob);
  if (/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i.test(text)) throw new Error(`secret leak ${label}`);
  if (/redis:\/\/[^:\s]+:[^@\s]+@/i.test(text)) throw new Error(`secret leak ${label}`);
}

async function soft(runner, cmd) {
  try {
    const r = await runner.execute(cmd, { timeoutMs: 45_000 });
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim().slice(0, 800),
    };
  } catch (e) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

function redactLog(text) {
  return redactSecrets(String(text || ''), [])
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, 'postgres://[REDACTED]')
    .replace(/redis:\/\/[^\s"']+/gi, 'redis://[REDACTED]')
    .replace(/(DATABASE_URL|REDIS_URL|JWT_SECRET|PASSWORD|SECRET)=([^\s"']+)/gi, '$1=[REDACTED]')
    .slice(0, 4000);
}

function classifyRootCause(input) {
  const msg = `${input.errorMessage || ''}\n${input.logBlob || ''}`.toLowerCase();
  if (/runtime_public_bind|0\.0\.0\.0:39/.test(msg)) return 'RUNTIME_PUBLIC_BIND_FORBIDDEN';
  if (/upload|scp|sftp|transfer/.test(msg) && /fail|error|timeout/.test(msg)) {
    return 'REMOTE_UPLOAD_FAILED';
  }
  if (/artifact|checksum|verify|no ready artifact/.test(msg)) return 'ARTIFACT_VERIFY_FAILED';
  if (/dockerfile|build.*image|podman build|docker build/.test(msg) && /fail|error/.test(msg)) {
    return 'RUNTIME_PREPARE_FAILED';
  }
  if (/address already in use|eaddrinuse|port.*in use|bind:/.test(msg)) return 'PORT_BIND_FAILED';
  if (/exited|dead|not running|exit code/.test(msg) && /container|podman|docker/.test(msg)) {
    return 'CONTAINER_EXITED';
  }
  if (/database|postgres|econnrefused.*5432|relation|migration/.test(msg)) {
    return 'DEPENDENCY_CONNECTION_FAILED';
  }
  if (/redis|econnrefused.*6379/.test(msg)) return 'DEPENDENCY_CONNECTION_FAILED';
  if (/missing.*env|config.*missing|runtime_config/.test(msg)) return 'RUNTIME_CONFIG_MISSING';
  if (/health|未能通过健康检查|econnrefused|timeout/.test(msg)) {
    if (input.containerState === 'exited' || input.containerExitCode) return 'CONTAINER_EXITED';
    if (input.getRootOk && !input.getHealthOk) return 'HEALTH_PATH_INVALID';
    if (!input.portListening) return 'CONTAINER_START_FAILED';
    return 'HEALTH_CHECK_FAILED';
  }
  if (/start|run.*fail|cannot start/.test(msg)) return 'CONTAINER_START_FAILED';
  if (/not runnable|no package\.json|cannot find module/.test(msg)) return 'ARTIFACT_NOT_RUNNABLE';
  return input.failedStepKey ? `STEP_FAILED:${input.failedStepKey}` : 'DEPLOYMENT_INCOMPLETE';
}

async function main() {
  const prisma = new PrismaClient();
  let password = '';

  try {
    const deployment = await prisma.deployment.findUnique({
      where: { id: DEPLOYMENT_ID },
      include: {
        steps: { orderBy: { order: 'asc' } },
        artifacts: { orderBy: { createdAt: 'asc' } },
        logs: { orderBy: { createdAt: 'asc' }, take: 500 },
        remoteDeployments: true,
        deployableUnit: {
          select: { id: true, name: true, type: true, port: true, rootPath: true },
        },
        serverInstance: true,
        diagnoses: { orderBy: { createdAt: 'desc' }, take: 3 },
      },
    });
    if (!deployment) throw new Error('deployment not found');

    // Also load step command logs for failed step
    const stepLogs = await prisma.deploymentStepLog.findMany({
      where: { deploymentId: DEPLOYMENT_ID },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        stepId: true,
        command: true,
        exitCode: true,
        duration: true,
        stdout: true,
        stderr: true,
      },
    });

    const services = await prisma.serviceInstance.findMany({
      where: {
        OR: [
          { projectId: deployment.projectId, deployableUnitId: deployment.deployableUnitId },
          // linked via logs/labels may not have FK — also by recent on this server
          {
            projectId: deployment.projectId,
            serverInstanceId: deployment.serverInstanceId,
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const artifactExpected = await prisma.artifact.findUnique({
      where: { id: EXPECTED_ARTIFACT },
    });

    const jobId = deploymentJobId(DEPLOYMENT_ID);
    let jobTerminalState = null;
    let jobFailedReason = null;
    try {
      const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      });
      await connection.connect();
      const queue = new Queue(DEPLOYMENT_QUEUE, { connection });
      const job = await queue.getJob(jobId);
      jobTerminalState = job ? await job.getState() : null;
      jobFailedReason = job?.failedReason ? redactLog(job.failedReason).slice(0, 500) : null;
      await queue.close().catch(() => undefined);
      await connection.quit().catch(() => undefined);
    } catch (e) {
      jobTerminalState = `queue_error:${e instanceof Error ? e.message : String(e)}`;
    }

    const steps = deployment.steps.map((s) => ({
      stepKey: s.stepKey,
      name: s.name,
      status: s.status,
      order: s.order,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      exitCode: s.exitCode ?? null,
      durationMs: s.duration ?? null,
      errorMessage: s.errorMessage ? redactLog(s.errorMessage).slice(0, 500) : null,
      command: s.command ? redactLog(s.command).slice(0, 200) : null,
    }));

    const failedStep =
      [...steps].reverse().find((s) => s.status === 'FAILED') ||
      steps.find((s) => s.status === 'FAILED') ||
      null;
    const lastStep = steps.filter((s) => s.startedAt).at(-1) || steps.at(-1) || null;

    const logBlob = deployment.logs.map((l) => l.message).join('\n');
    const safeLogs = redactLog(logBlob);

    // Infer phases from logs
    const phaseHints = {
      ALLOCATING_PORT: /hostPort=|分配|allocate.*port/i.test(logBlob),
      UPLOADING_ARTIFACT: /\[上传\]|upload/i.test(logBlob),
      PREPARING_RUNTIME: /docker build|podman build|构建/i.test(logBlob),
      STARTING_SERVICE: /启动应用|docker run|podman run/i.test(logBlob),
      HEALTH_CHECK: /健康检查|health/i.test(logBlob),
    };

    const hostPortMatch = /hostPort=(\d+)/.exec(logBlob);
    const healthUrlMatch = /http:\/\/127\.0\.0\.1:(\d+)/.exec(logBlob);
    const containerNameMatch =
      /启动应用\s+(launchos-[a-z0-9]+)/i.exec(logBlob) ||
      /--name\s+(launchos-[a-z0-9]+)/i.exec(logBlob);
    const inferredPort = hostPortMatch
      ? Number(hostPortMatch[1])
      : healthUrlMatch
        ? Number(healthUrlMatch[1])
        : null;
    const inferredContainerName = containerNameMatch?.[1] || `launchos-${DEPLOYMENT_ID.slice(0, 10).toLowerCase()}`;

    const relatedServices = services.filter(
      (s) =>
        s.serverInstanceId === deployment.serverInstanceId ||
        (inferredPort && (s.externalPort === inferredPort || s.port === inferredPort)),
    );
    const newFailedService =
      relatedServices.find((s) => s.status === 'FAILED' || s.status === 'STOPPED') ||
      relatedServices.find((s) => s.externalPort === inferredPort || s.port === inferredPort) ||
      null;
    const previousHealthy = services.find(
      (s) =>
        s.status === 'RUNNING' &&
        s.healthStatus === 'HEALTHY' &&
        s.serverInstanceId !== deployment.serverInstanceId,
    );
    const previousHealthyOnTarget = services.find(
      (s) =>
        s.status === 'RUNNING' &&
        s.healthStatus === 'HEALTHY' &&
        s.serverInstanceId === deployment.serverInstanceId &&
        s.id !== newFailedService?.id,
    );

    // —— SSH read-only ——
    const server = deployment.serverInstance;
    if (!server || server.host !== TARGET_HOST || server.id !== EXPECTED_SI) {
      throw new Error(`server mismatch host=${server?.host} id=${server?.id}`);
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

    const remoteDir = `/opt/launchos/apps/${deployment.projectId}/${deployment.deployableUnitId}/${DEPLOYMENT_ID}`;
    const dirExists = await soft(runner, shellCommand(`test -d ${JSON.stringify(remoteDir)} && echo yes || echo no`));
    const dirListing = await soft(
      runner,
      shellCommand(`ls -la ${JSON.stringify(remoteDir)} 2>/dev/null | head -n 40 || true`),
    );
    const pkgJson = await soft(
      runner,
      shellCommand(`test -f ${JSON.stringify(remoteDir + '/package.json')} && echo yes || echo no`),
    );
    const artifactFiles = await soft(
      runner,
      shellCommand(
        `find ${JSON.stringify(remoteDir)} -maxdepth 2 -type f 2>/dev/null | head -n 40 || true`,
      ),
    );
    const du = await soft(
      runner,
      shellCommand(`du -sh ${JSON.stringify(remoteDir)} 2>/dev/null || true`),
    );

    const ps = await soft(runner, shellCommand('podman ps -a --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}" 2>/dev/null | head -n 40'));
    const psRunning = await soft(runner, shellCommand('podman ps --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}" 2>/dev/null | head -n 40'));

    let inspect = { exitCode: -1, stdout: '', stderr: '' };
    let logs = { exitCode: -1, stdout: '', stderr: '' };
    let containerId = newFailedService?.containerId || null;
    const nameToUse = inferredContainerName;

    const byName = await soft(
      runner,
      shellCommand(
        `podman inspect ${JSON.stringify(nameToUse)} --format '{{.Id}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.RestartCount}}|{{json .Config.Cmd}}|{{json .Config.Entrypoint}}|{{.Config.WorkingDir}}|{{json .HostConfig.PortBindings}}|{{json .Config.Env}}' 2>/dev/null || true`,
      ),
    );
    if (byName.stdout) {
      inspect = byName;
      const parts = byName.stdout.split('|');
      containerId = (parts[0] || '').replace(/^sha256:/, '').slice(0, 64) || containerId;
    } else if (containerId) {
      inspect = await soft(
        runner,
        shellCommand(
          `podman inspect ${JSON.stringify(containerId)} --format '{{.Id}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.RestartCount}}|{{json .Config.Cmd}}|{{json .Config.Entrypoint}}|{{.Config.WorkingDir}}|{{json .HostConfig.PortBindings}}|{{json .Config.Env}}' 2>/dev/null || true`,
        ),
      );
    }

    const inspectTarget = containerId || nameToUse;
    logs = await soft(
      runner,
      shellCommand(`podman logs --tail 200 ${JSON.stringify(inspectTarget)} 2>&1 || true`),
    );

    const ssOut = await soft(runner, shellCommand('ss -lntp 2>/dev/null || true'));
    const port = inferredPort || newFailedService?.externalPort || newFailedService?.port || 39000;
    const listenLine = (ssOut.stdout || '')
      .split(/\r?\n/)
      .filter((l) => l.includes(`:${port}`) || l.includes(`:${port - 0}`));

    const curlHealth = await soft(
      runner,
      shellCommand(
        `curl -i --max-time 5 http://127.0.0.1:${port}/health 2>&1 | head -n 30 || true`,
      ),
    );
    const curlRoot = await soft(
      runner,
      shellCommand(`curl -i --max-time 5 http://127.0.0.1:${port}/ 2>&1 | head -n 30 || true`),
    );

    // Env presence from inspect Env json — keys only
    let envPresence = {
      DATABASE_URL: false,
      REDIS_URL: false,
      JWT_SECRET: false,
      PORT: false,
      NODE_ENV: false,
    };
    let containerState = null;
    let containerExitCode = null;
    let containerRestartCount = null;
    let cmd = null;
    let entrypoint = null;
    let workingDir = null;
    let portBindings = null;
    let bindAddress = null;

    if (inspect.stdout) {
      const parts = inspect.stdout.split('|');
      containerState = parts[1] || null;
      containerExitCode = parts[2] != null && parts[2] !== '' ? Number(parts[2]) : null;
      containerRestartCount = parts[3] != null && parts[3] !== '' ? Number(parts[3]) : null;
      cmd = parts[4] || null;
      entrypoint = parts[5] || null;
      workingDir = parts[6] || null;
      portBindings = parts[7] || null;
      const envJson = parts.slice(8).join('|');
      try {
        const envs = JSON.parse(envJson);
        if (Array.isArray(envs)) {
          const keys = envs.map((e) => String(e).split('=')[0]);
          envPresence = {
            DATABASE_URL: keys.includes('DATABASE_URL'),
            REDIS_URL: keys.includes('REDIS_URL'),
            JWT_SECRET: keys.includes('JWT_SECRET'),
            PORT: keys.includes('PORT'),
            NODE_ENV: keys.includes('NODE_ENV'),
          };
        }
      } catch {
        // ignore
      }
      if (portBindings && portBindings.includes('127.0.0.1')) bindAddress = '127.0.0.1';
      else if (portBindings && portBindings.includes('0.0.0.0')) bindAddress = '0.0.0.0';
    }

    await runner.disconnect();

    const safeContainerLogs = redactLog(logs.stdout || logs.stderr);
    const depLogFindings = [];
    if (/postgres|database|econnrefused.*5432|sequelize|prisma/i.test(safeContainerLogs)) {
      depLogFindings.push('possible_database_issue');
    }
    if (/redis|econnrefused.*6379|ioredis/i.test(safeContainerLogs)) {
      depLogFindings.push('possible_redis_issue');
    }
    if (/missing|undefined|env|JWT_SECRET|DATABASE_URL|REDIS_URL/i.test(safeContainerLogs)) {
      depLogFindings.push('possible_missing_env');
    }
    if (/migration|migrate/i.test(safeContainerLogs)) depLogFindings.push('possible_migration_issue');
    if (/address already in use|eaddrinuse/i.test(safeContainerLogs)) {
      depLogFindings.push('possible_port_conflict');
    }

    const getHealthOk = /HTTP\/\d\.\d\s+200/.test(curlHealth.stdout);
    const getRootOk = /HTTP\/\d\.\d\s+200/.test(curlRoot.stdout);
    const portListening = listenLine.length > 0;

    const rootCause = classifyRootCause({
      errorMessage: failedStep?.errorMessage || deployment.errorMessage,
      logBlob: `${safeLogs}\n${safeContainerLogs}`,
      containerState,
      containerExitCode,
      getRootOk,
      getHealthOk,
      portListening,
      failedStepKey: failedStep?.stepKey,
    });

    // DATABASE_URL duplicate cause — config merge
    const configValues = await prisma.runtimeConfigValue.findMany({
      where: {
        projectId: deployment.projectId,
        key: { in: ['DATABASE_URL', 'REDIS_URL'] },
      },
      select: {
        id: true,
        key: true,
        scopeType: true,
        scopeId: true,
        deployableUnitId: true,
        provider: true,
        isSensitive: true,
      },
    });

    const businessStateConsistent =
      deployment.status === 'FAILED' &&
      (jobTerminalState === 'failed' ||
        jobTerminalState === 'completed' ||
        // bullmq may complete job after catching failure depending on worker
        jobTerminalState === 'failed');

    // Prefer: FAILED deployment should have failed job; completed job + FAILED is also common if worker finishes after marking failed
    const consistentStrict =
      deployment.status === 'FAILED' &&
      jobTerminalState !== 'active' &&
      jobTerminalState !== 'waiting' &&
      jobTerminalState !== 'delayed';

    const report = {
      WRITE_COMMANDS_EXECUTED_THIS_RUN,
      historicalWriteCommandsExecuted: true,
      deploymentId: DEPLOYMENT_ID,
      status: deployment.status,
      version: deployment.version,
      serverInstanceId: deployment.serverInstanceId,
      deployableUnitId: deployment.deployableUnitId,
      errorMessage: deployment.errorMessage ? redactLog(deployment.errorMessage) : null,
      retryCount: deployment.retryCount,
      maxRetry: deployment.maxRetry,
      jobId,
      jobTerminalState,
      jobFailedReason,
      businessStateConsistent: consistentStrict,
      steps,
      failedStep: failedStep?.stepKey || null,
      lastStep: lastStep?.stepKey || null,
      failedOperation: failedStep?.command || failedStep?.stepKey || null,
      errorCode: failedStep?.errorCode || rootCause,
      phaseHints,
      inferredPort,
      inferredContainerName,
      artifactsOnDeployment: deployment.artifacts.map((a) => ({
        id: a.id,
        type: a.type,
        status: a.status,
        size: a.size,
        storagePath: a.storagePath ? String(a.storagePath).slice(0, 120) : null,
      })),
      expectedArtifact: artifactExpected
        ? {
            id: artifactExpected.id,
            type: artifactExpected.type,
            status: artifactExpected.status,
            size: artifactExpected.size,
            storagePath: artifactExpected.storagePath
              ? String(artifactExpected.storagePath).slice(0, 120)
              : null,
            checksum: null,
          }
        : null,
      stepCommandLogs: stepLogs.map((l) => ({
        stepId: l.stepId,
        command: redactLog(l.command).slice(0, 200),
        exitCode: l.exitCode,
        duration: l.duration,
        stdout: redactLog(l.stdout).slice(0, 400),
        stderr: redactLog(l.stderr).slice(0, 400),
      })),
      remoteDirectory: {
        path: remoteDir,
        exists: dirExists.stdout === 'yes',
        packageJson: pkgJson.stdout === 'yes',
        du: du.stdout,
        listing: redactLog(dirListing.stdout).slice(0, 1500),
        files: redactLog(artifactFiles.stdout).slice(0, 1500),
      },
      podmanPsAll: redactLog(ps.stdout).slice(0, 1500),
      podmanPsRunning: redactLog(psRunning.stdout).slice(0, 800),
      container: {
        created: Boolean(inspect.stdout),
        id: containerId,
        name: nameToUse,
        state: containerState,
        exitCode: containerExitCode,
        restartCount: containerRestartCount,
        cmd,
        entrypoint,
        workingDir,
        portBindings: portBindings ? redactLog(portBindings).slice(0, 500) : null,
        bindAddress,
      },
      envPresence,
      portListening,
      listenLines: listenLine.slice(0, 5).map((l) => l.slice(0, 160)),
      curlHealth: redactLog(curlHealth.stdout).slice(0, 800),
      curlRoot: redactLog(curlRoot.stdout).slice(0, 800),
      getHealthOk,
      getRootOk,
      containerLogsExcerpt: safeContainerLogs.slice(0, 2500),
      depLogFindings,
      configUrlKeys: configValues,
      databaseUrlDuplicateCause:
        'dry-run configKeysPresent listed both PROJECT-scope and UNIT/provider-managed DATABASE_URL rows; merge precedence is managed/provider > unit > project (not a runtime conflict by itself)',
      services: relatedServices.map((s) => ({
        id: s.id,
        status: s.status,
        healthStatus: s.healthStatus,
        serverInstanceId: s.serverInstanceId,
        port: s.port,
        externalPort: s.externalPort,
        containerId: s.containerId,
        createdAt: s.createdAt,
      })),
      previousHealthyRevisionOnOldServer: previousHealthy
        ? {
            id: previousHealthy.id,
            serverInstanceId: previousHealthy.serverInstanceId,
            port: previousHealthy.externalPort || previousHealthy.port,
          }
        : null,
      previousHealthyOnTarget: previousHealthyOnTarget
        ? { id: previousHealthyOnTarget.id }
        : null,
      newFailedServiceInstance: newFailedService
        ? {
            id: newFailedService.id,
            status: newFailedService.status,
            containerId: newFailedService.containerId,
            port: newFailedService.externalPort || newFailedService.port,
          }
        : null,
      diagnoses: deployment.diagnoses.map((d) => ({
        category: d.category,
        title: d.title,
        description: d.description ? redactLog(d.description).slice(0, 300) : null,
      })),
      recentSafeLogs: safeLogs.slice(-2500),
      rootCause,
      oldServerUntouched: true,
    };

    assertNoSecret(report, 'diagnosis-report');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    password = '';
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(redactSecrets(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
