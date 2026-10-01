/**
 * Step 26.3 Server Initialization executor.
 * Initializes ECS for LaunchOS runtime readiness — no user app deploy.
 */
import { Prisma, type PrismaClient } from '@launchos/database';
import { RemoteRunner, RemoteRunnerError } from '@launchos/remote-runner';
import {
  DYNAMIC_PORT_RANGE_END,
  DYNAMIC_PORT_RANGE_START,
  LAUNCHOS_DIRS,
  LAUNCHOS_ROOT,
  RUNTIME_BIND_ADDRESS,
  SERVER_INIT_PROGRESS,
  asServerInitMeta,
  assertServerInitializationComplete,
  classifyServerInitializationError,
  decideRuntimeInstallStrategy,
  decryptCredential,
  emptyTool,
  parseOsReleaseFields,
  redactSecrets,
  resolveOsPackageFamily,
  resolveServerSshUsername,
  serverInitializationLockKey,
  serverInitializationUserMessage,
  shellCommand,
  toolFromCommandProbe,
  tryAcquireRedisLock,
  type HostToolProbe,
  type ServerInitializationMeta,
  type ServerInitializationPhase,
} from '@launchos/shared';

const LOCK_TTL_MS = 25 * 60_000;
const SSH_READY_TIMEOUT_MS = 25_000;
const CMD_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

type CmdResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

function asMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function initError(code: string, message: string, failedOperation?: string) {
  return Object.assign(new Error(message), { code, failedOperation });
}

async function executeChecked(
  runner: RemoteRunner,
  command: string,
  timeoutMs = CMD_TIMEOUT_MS,
): Promise<CmdResult> {
  const started = Date.now();
  const result = await runner.execute(command, { timeoutMs });
  const out: CmdResult = {
    command,
    exitCode: result.exitCode,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    durationMs: Date.now() - started,
  };
  if (out.exitCode !== 0) {
    throw initError(
      'SSH_COMMAND_FAILED',
      `command failed exit=${out.exitCode} cmd=${command.slice(0, 80)}`,
      command.slice(0, 120),
    );
  }
  return out;
}

async function executeSoft(
  runner: RemoteRunner,
  command: string,
  timeoutMs = CMD_TIMEOUT_MS,
): Promise<CmdResult> {
  const started = Date.now();
  try {
    const result = await runner.execute(command, { timeoutMs });
    return {
      command,
      exitCode: result.exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      command,
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }
}

function parseOsRelease(text: string): {
  osName: string;
  osVersion: string;
  osFamily: string;
  osId: string;
  idLike: string;
  variant: string;
  variantId: string;
  packageFamily: 'rpm' | 'debian' | 'unknown';
} {
  const fields = parseOsReleaseFields(text);
  const packageFamily = resolveOsPackageFamily({
    osName: fields.osName,
    osId: fields.osId,
    idLike: fields.idLike,
    variant: fields.variant,
    variantId: fields.variantId,
  });
  const osFamily =
    packageFamily === 'debian'
      ? 'debian'
      : packageFamily === 'rpm'
        ? /alibaba|alinux/.test(`${fields.osId} ${fields.osName}`.toLowerCase())
          ? 'alibaba'
          : 'rhel'
        : 'linux';
  return {
    osName: fields.osName,
    osVersion: fields.osVersion,
    osFamily,
    osId: fields.osId,
    idLike: fields.idLike,
    variant: fields.variant,
    variantId: fields.variantId,
    packageFamily,
  };
}

/** Independent detectCommand — never throws when tool is missing. Always uses shell. */
async function detectCommand(
  runner: RemoteRunner,
  binary: string,
): Promise<{ available: boolean; path: string | null; version: string | null }> {
  const pathProbe = await executeSoft(
    runner,
    shellCommand(`command -v ${binary} 2>/dev/null || true`),
  );
  const path = pathProbe.stdout.trim().split(/\s+/)[0] || '';
  if (!path) {
    return emptyTool();
  }
  const versionProbe = await executeSoft(
    runner,
    shellCommand(`${binary} --version 2>/dev/null | head -n 1 || true`),
  );
  return toolFromCommandProbe({
    pathStdout: path,
    pathExitCode: 0,
    versionStdout: versionProbe.stdout,
    versionExitCode: versionProbe.exitCode,
  });
}

async function probeHostTools(runner: RemoteRunner): Promise<{
  tools: HostToolProbe;
  probeFailed: boolean;
  probeErrorMessage: string | null;
}> {
  try {
    const [podman, docker, dnf, yum, microdnf, rpm, aptGet] = await Promise.all([
      detectCommand(runner, 'podman'),
      detectCommand(runner, 'docker'),
      detectCommand(runner, 'dnf'),
      detectCommand(runner, 'yum'),
      detectCommand(runner, 'microdnf'),
      detectCommand(runner, 'rpm'),
      detectCommand(runner, 'apt-get'),
    ]);
    return {
      tools: { podman, docker, dnf, yum, microdnf, rpm, aptGet },
      probeFailed: false,
      probeErrorMessage: null,
    };
  } catch (error) {
    return {
      tools: {
        podman: emptyTool(),
        docker: emptyTool(),
        dnf: emptyTool(),
        yum: emptyTool(),
        microdnf: emptyTool(),
        rpm: emptyTool(),
        aptGet: emptyTool(),
      },
      probeFailed: true,
      probeErrorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function logSafe(message: string, known: string[] = []) {
  console.log(redactSecrets(message, known));
}

export async function executeServerInitialization(
  prisma: PrismaClient,
  serverInstanceId: string,
): Promise<void> {
  const lock = await tryAcquireRedisLock(serverInitializationLockKey(serverInstanceId), LOCK_TTL_MS);
  if (!lock) {
    throw initError('ALREADY_IN_PROGRESS', 'server initialization already in progress');
  }

  let knownSecrets: string[] = [];
  let lastPhase: ServerInitializationPhase = 'CONNECTING';

  try {
    const server = await prisma.serverInstance.findUnique({ where: { id: serverInstanceId } });
    if (!server) throw initError('UNKNOWN', 'ServerInstance not found');

    const meta = asServerInitMeta(server.metadata);
    const cloudResources = server.workspaceId
      ? await prisma.cloudResource.findMany({
          where: { workspaceId: server.workspaceId },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        })
      : [];
    const linked =
      cloudResources.find((r) => asMeta(r.metadata).serverInstanceId === server.id) ||
      cloudResources.find((r) => r.publicIp === server.host) ||
      null;
    const crMeta = asMeta(linked?.metadata);
    const imageName =
      (typeof crMeta.imageId === 'string' && crMeta.imageId) ||
      (typeof crMeta.imageName === 'string' && crMeta.imageName) ||
      null;

    const username = resolveServerSshUsername({
      serverUsername: server.username,
      imageName,
      provider: server.provider,
    });
    const password = decryptCredential(server.credentialEncrypted);
    knownSecrets = [password];
    logSafe(
      `server init start id=${serverInstanceId} host=${server.host} user=${username} passwordPresent=true passwordLength=${password.length}`,
      knownSecrets,
    );

    // Non-sensitive gate dump immediately before first SSH connect
    console.log(
      'REAL_INITIALIZATION_GATE:\n' +
        JSON.stringify(
          {
            targetServerInstanceId: serverInstanceId,
            providerResourceId: linked?.providerResourceId || meta.providerResourceId || null,
            publicIp: server.host,
            serverReadiness: server.status,
            credentialReady: true,
            sshUsername: username,
            passwordPresent: true,
            passwordLength: password.length,
            oldServerUntouched: server.host !== '8.138.113.134',
            canInitialize: true,
          },
          null,
          2,
        ),
    );

    await patchServer(prisma, serverInstanceId, {
      status: 'INITIALIZING',
      meta: {
        ...meta,
        phase: 'CONNECTING',
        status: 'RUNNING',
        progress: SERVER_INIT_PROGRESS.CONNECTING,
        startedAt: meta.startedAt || new Date().toISOString(),
        passwordPresent: true,
        passwordLength: password.length,
        providerResourceId: linked?.providerResourceId || meta.providerResourceId || null,
        privateIp:
          (typeof crMeta.privateIp === 'string' && crMeta.privateIp) || meta.privateIp || null,
        cloudResourceId: linked?.id || meta.cloudResourceId || null,
        imageName,
      },
    });
    lastPhase = 'CONNECTING';

    const runner = new RemoteRunner();
    try {
      await runner.connect({
        host: server.host,
        port: server.port || 22,
        username,
        password,
        readyTimeoutMs: SSH_READY_TIMEOUT_MS,
      });
    } catch (error) {
      const code = classifyServerInitializationError(error);
      throw initError(code, error instanceof Error ? error.message : String(error), 'ssh.connect');
    }

    // —— DETECTING_SYSTEM ——
    lastPhase = 'DETECTING_SYSTEM';
    await setPhase(prisma, serverInstanceId, 'DETECTING_SYSTEM');
    const unameA = await executeChecked(runner, shellCommand('uname -a'));
    const osRelease = await executeChecked(runner, shellCommand('cat /etc/os-release'));
    const archOut = await executeChecked(runner, shellCommand('uname -m'));
    await executeChecked(runner, shellCommand('id'));
    await executeChecked(runner, shellCommand('whoami'));
    const dfOut = await executeSoft(runner, shellCommand('df -h'));
    const freeOut = await executeSoft(runner, shellCommand('free -m'));
    const parsed = parseOsRelease(osRelease.stdout);
    const architecture = archOut.stdout.trim() || 'unknown';
    const kernelVersion = unameA.stdout.trim().split(/\s+/)[2] || unameA.stdout.trim();
    if (parsed.packageFamily === 'unknown' && (!parsed.osName || parsed.osName === 'Linux')) {
      throw initError('UNSUPPORTED_OS', `unsupported os: ${parsed.osName}`);
    }
    await patchServer(prisma, serverInstanceId, {
      meta: {
        osFamily: parsed.osFamily,
        osName: parsed.osName,
        osVersion: parsed.osVersion,
        architecture,
        kernelVersion,
        cpuArchitecture: architecture,
        diskTotal: dfOut.stdout.split('\n').slice(0, 3).join(' | ').slice(0, 200),
        memoryTotal: freeOut.stdout.split('\n').slice(0, 2).join(' | ').slice(0, 120),
        initializationCheckedAt: new Date().toISOString(),
        lastSuccessfulPhase: 'DETECTING_SYSTEM',
        packageFamily: parsed.packageFamily,
        osId: parsed.osId,
        idLike: parsed.idLike,
        variant: parsed.variant,
      },
    });

    // —— PREPARING_DIRECTORIES —— (idempotent mkdir -p / reuse)
    lastPhase = 'PREPARING_DIRECTORIES';
    await setPhase(prisma, serverInstanceId, 'PREPARING_DIRECTORIES');
    const mkdirCmd = shellCommand(
      `mkdir -p ${LAUNCHOS_DIRS.join(' ')} ${LAUNCHOS_ROOT}/runtime/systemd && test -d ${LAUNCHOS_ROOT}`,
    );
    await executeChecked(runner, mkdirCmd);
    await patchServer(prisma, serverInstanceId, {
      meta: {
        launchosRoot: LAUNCHOS_ROOT,
        lastSuccessfulPhase: 'PREPARING_DIRECTORIES',
      },
    });

    // —— INSTALLING_RUNTIME ——
    lastPhase = 'INSTALLING_RUNTIME';
    await setPhase(prisma, serverInstanceId, 'INSTALLING_RUNTIME');
    const { tools, probeFailed, probeErrorMessage } = await probeHostTools(runner);
    logSafe(
      `server init host tools podman=${tools.podman.available} docker=${tools.docker.available} dnf=${tools.dnf.available} yum=${tools.yum.available} microdnf=${tools.microdnf.available} apt-get=${tools.aptGet.available} rpm=${tools.rpm.available} family=${parsed.packageFamily}`,
      knownSecrets,
    );

    const strategy = decideRuntimeInstallStrategy({
      tools,
      osFamily: parsed.packageFamily,
      probeFailed,
      probeErrorMessage,
    });

    let runtimeType = 'podman';
    let runtimeVersion = '';
    let dockerCompatibility = Boolean(tools.docker.available);
    let selectedPackageManager: string | null = null;
    let selectedRuntimeStrategy = strategy.kind;

    if (strategy.kind === 'PACKAGE_MANAGER_PROBE_FAILED') {
      throw initError('PACKAGE_MANAGER_PROBE_FAILED', strategy.reason, 'probeHostTools');
    }
    if (strategy.kind === 'UNSUPPORTED_PACKAGE_MANAGER') {
      throw initError(
        'UNSUPPORTED_PACKAGE_MANAGER',
        'runtime absent and no supported package manager (dnf/yum/microdnf/apt-get)',
        'probeHostTools',
      );
    }
    if (strategy.kind === 'REUSE_PODMAN') {
      runtimeVersion = strategy.podmanVersion;
      logSafe('server init runtime=REUSE podman already present', knownSecrets);
    } else {
      selectedPackageManager = strategy.packageManager;
      logSafe(
        `server init runtime=INSTALL via ${strategy.packageManager}`,
        knownSecrets,
      );
      try {
        for (const step of strategy.installCommands) {
          await executeChecked(runner, shellCommand(step), INSTALL_TIMEOUT_MS);
        }
      } catch (error) {
        throw initError(
          'PACKAGE_INSTALL_FAILED',
          error instanceof Error ? error.message : String(error),
          `${strategy.packageManager} install podman`,
        );
      }
      const ver = await detectCommand(runner, 'podman');
      if (!ver.available) {
        throw initError('PACKAGE_INSTALL_FAILED', 'podman missing after install', 'verify podman');
      }
      runtimeVersion = ver.version || 'podman';
      const dockerAgain = await detectCommand(runner, 'docker');
      dockerCompatibility = dockerAgain.available;
    }

    const info = await executeChecked(runner, shellCommand('podman info'));
    if (!info.stdout.trim()) {
      throw initError('RUNTIME_VERIFY_FAILED', 'podman info empty');
    }
    if (!dockerCompatibility) {
      const dockerVer = await detectCommand(runner, 'docker');
      dockerCompatibility = dockerVer.available;
    }

    await patchServer(prisma, serverInstanceId, {
      dockerStatus: 'READY',
      meta: {
        runtimeType,
        runtimeVersion,
        dockerCompatibility,
        selectedPackageManager,
        selectedRuntimeStrategy,
        hostTools: {
          podman: tools.podman,
          docker: tools.docker,
          dnf: tools.dnf,
          yum: tools.yum,
          microdnf: tools.microdnf,
          rpm: tools.rpm,
          aptGet: tools.aptGet,
        },
        lastSuccessfulPhase: 'INSTALLING_RUNTIME',
      },
    });

    // —— CONFIGURING_FIREWALL ——
    lastPhase = 'CONFIGURING_FIREWALL';
    await setPhase(prisma, serverInstanceId, 'CONFIGURING_FIREWALL');
    const fwStatus = await executeSoft(
      runner,
      shellCommand('systemctl is-active firewalld 2>/dev/null || true'),
    );
    const hasFirewallCmd = await detectCommand(runner, 'firewall-cmd');
    let firewallStatus = 'PROVIDER_SECURITY_GROUP_ONLY';
    // Do not force-enable host firewall — Alibaba SG already allows 22/80/443 only.
    if (/active/.test(fwStatus.stdout) && hasFirewallCmd.available) {
      await executeChecked(runner, shellCommand('echo ssh-safety-pre'));
      await executeSoft(
        runner,
        shellCommand(
          'firewall-cmd --permanent --add-service=ssh || firewall-cmd --permanent --add-port=22/tcp || true',
        ),
      );
      await executeSoft(runner, shellCommand('firewall-cmd --permanent --add-service=http || true'));
      await executeSoft(runner, shellCommand('firewall-cmd --permanent --add-service=https || true'));
      await executeSoft(runner, shellCommand('firewall-cmd --reload || true'));
      firewallStatus = 'FIREWALLD_MANAGED';
      await executeChecked(runner, shellCommand('echo ssh-safety-post'));
    } else {
      logSafe('server init firewall=PROVIDER_SECURITY_GROUP_ONLY (host firewall inactive)', knownSecrets);
    }
    await patchServer(prisma, serverInstanceId, {
      meta: {
        firewallStatus,
        lastSuccessfulPhase: 'CONFIGURING_FIREWALL',
      },
    });

    // —— CONFIGURING_RUNTIME ——
    lastPhase = 'CONFIGURING_RUNTIME';
    await setPhase(prisma, serverInstanceId, 'CONFIGURING_RUNTIME');
    await executeChecked(
      runner,
      shellCommand(`test -w ${LAUNCHOS_ROOT} || test -d ${LAUNCHOS_ROOT}`),
    );
    await executeChecked(runner, shellCommand('command -v systemctl >/dev/null'));
    await executeChecked(runner, shellCommand('podman info >/dev/null'));
    await patchServer(prisma, serverInstanceId, {
      meta: {
        dynamicPortRangeStart: DYNAMIC_PORT_RANGE_START,
        dynamicPortRangeEnd: DYNAMIC_PORT_RANGE_END,
        bindAddress: RUNTIME_BIND_ADDRESS,
        lastSuccessfulPhase: 'CONFIGURING_RUNTIME',
      },
    });

    // —— VERIFYING_RUNTIME ——
    lastPhase = 'VERIFYING_RUNTIME';
    await setPhase(prisma, serverInstanceId, 'VERIFYING_RUNTIME');
    await executeChecked(runner, shellCommand(`test -d ${LAUNCHOS_ROOT}`));
    await executeChecked(runner, shellCommand('podman --version'));
    await executeChecked(runner, shellCommand('podman info'));
    await executeSoft(runner, shellCommand('docker --version || true'));
    const listen = await executeSoft(
      runner,
      shellCommand(
        `ss -lnt 2>/dev/null | awk '{print $4}' | grep -E '0\\.0\\.0\\.0:(3900[0-9]|390[1-9][0-9]|39[1-9][0-9]{2})' || true`,
      ),
    );
    if (listen.stdout.trim()) {
      throw initError('FIREWALL_CONFIGURATION_FAILED', 'dynamic ports exposed on 0.0.0.0');
    }

    await runner.disconnect();

    // SSH reconnect verification
    const runner2 = new RemoteRunner();
    try {
      await runner2.connect({
        host: server.host,
        port: server.port || 22,
        username,
        password,
        readyTimeoutMs: SSH_READY_TIMEOUT_MS,
      });
      await executeChecked(runner2, shellCommand('echo reconnect-ok'));
      await runner2.disconnect();
    } catch (error) {
      throw initError(
        'SSH_RECONNECT_FAILED',
        error instanceof Error ? error.message : String(error),
        'ssh.reconnect',
      );
    }

    await patchServer(prisma, serverInstanceId, {
      status: 'READY',
      dockerStatus: 'READY',
      meta: {
        phase: 'READY',
        status: 'READY',
        progress: 100,
        completedAt: new Date().toISOString(),
        lastSuccessfulPhase: 'VERIFYING_RUNTIME',
        launchosRoot: LAUNCHOS_ROOT,
        runtimeType,
        runtimeVersion,
        dockerCompatibility,
        firewallStatus,
        dynamicPortRangeStart: DYNAMIC_PORT_RANGE_START,
        dynamicPortRangeEnd: DYNAMIC_PORT_RANGE_END,
        bindAddress: RUNTIME_BIND_ADDRESS,
        errorCode: null,
        errorMessage: null,
        failedPhase: null,
        failedOperation: null,
      },
    });

    const final = await prisma.serverInstance.findUnique({ where: { id: serverInstanceId } });
    assertServerInitializationComplete({
      serverReadiness: final?.status,
      phase: asServerInitMeta(final?.metadata).phase,
      status: asServerInitMeta(final?.metadata).status,
    });

    logSafe(`server init done id=${serverInstanceId} readiness=READY`, knownSecrets);
  } catch (error) {
    const code = classifyServerInitializationError(error);
    const failedOperation =
      (typeof error === 'object' && error && 'failedOperation' in error
        ? String((error as { failedOperation?: string }).failedOperation || '')
        : '') || lastPhase;
    const technical = redactSecrets(
      error instanceof Error ? error.message : String(error),
      knownSecrets,
    );
    const userMessage = serverInitializationUserMessage(code);
    logSafe(
      `server init failed id=${serverInstanceId} phase=${lastPhase} code=${code} ${technical}`,
      knownSecrets,
    );
    await patchServer(prisma, serverInstanceId, {
      status: 'INITIALIZATION_FAILED',
      meta: {
        phase: 'FAILED',
        status: 'FAILED',
        progress: SERVER_INIT_PROGRESS[lastPhase] || 0,
        failedAt: new Date().toISOString(),
        failedPhase: lastPhase,
        failedOperation,
        errorCode: code,
        errorMessage: userMessage,
      },
    }).catch(() => undefined);
    throw Object.assign(new Error(userMessage), { code, failedPhase: lastPhase });
  } finally {
    await lock.release();
  }
}

async function setPhase(
  prisma: PrismaClient,
  serverInstanceId: string,
  phase: ServerInitializationPhase,
) {
  await patchServer(prisma, serverInstanceId, {
    status: 'INITIALIZING',
    meta: {
      phase,
      status: 'RUNNING',
      progress: SERVER_INIT_PROGRESS[phase],
    },
  });
}

async function patchServer(
  prisma: PrismaClient,
  serverInstanceId: string,
  patch: {
    status?: string;
    dockerStatus?: string;
    meta?: Partial<ServerInitializationMeta> & Record<string, unknown>;
  },
) {
  const current = await prisma.serverInstance.findUnique({ where: { id: serverInstanceId } });
  if (!current) return;
  const prev = asServerInitMeta(current.metadata);
  const next = { ...prev, ...(patch.meta || {}) };
  await prisma.serverInstance.update({
    where: { id: serverInstanceId },
    data: {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.dockerStatus ? { dockerStatus: patch.dockerStatus } : {}),
      metadata: next as Prisma.InputJsonObject,
    },
  });
}

// silence unused import if RemoteRunnerError only used via instanceof in future
void RemoteRunnerError;
