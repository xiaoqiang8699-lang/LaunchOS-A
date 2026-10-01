import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Docker from 'dockerode';
import { DockerCliError, runDocker } from './docker-cli';
import {
  generateDockerFiles,
  isDockerSupportedFramework,
  resolvePreInstallCopyPaths,
} from './dockerfile';
import type {
  CreateRuntimeOptions,
  CreateRuntimeResult,
  HttpProbeResult,
  RuntimeMode,
  RuntimeProvider,
  RuntimeStatus,
} from './types';

const DEFAULT_IMAGE = 'node:20';
const DEFAULT_CONTAINER_PORT = 3000;
const MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const CPU_LIMIT = 1_000_000_000;
const READY_TIMEOUT_MS = 60_000;

const START_COMMAND = [
  'sh',
  '-c',
  'mkdir -p /app && until [ -f /app/dist/index.js ] || [ -f /app/index.js ]; do sleep 0.2; done; if [ -f /app/dist/index.js ]; then exec node /app/dist/index.js; else exec node /app/index.js; fi',
];

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export function readRuntimeMode(value = process.env.LAUNCHOS_RUNTIME_MODE): RuntimeMode {
  return value?.trim().toLowerCase() === 'mock' ? 'mock' : 'docker';
}

export class LocalDockerRuntime implements RuntimeProvider {
  readonly kind = 'local' as const;

  constructor(private readonly docker = createDocker()) {}

  async createRuntime(options: CreateRuntimeOptions): Promise<CreateRuntimeResult> {
    const mode = options.mode ?? 'mock';
    if (mode === 'docker') {
      return this.createDockerRuntime(options);
    }
    return this.createMockRuntime(options);
  }

  async startRuntime(containerId: string): Promise<RuntimeStatus> {
    const container = this.docker.getContainer(containerId);
    const inspect = await container.inspect();
    if (!inspect.State.Running) {
      await container.start();
    }

    const status = await this.waitUntilReady(containerId);
    console.log(
      `LaunchOS Runtime started container ${containerId} on port ${status.port ?? 'unknown'}`,
    );
    return status;
  }

  async stopRuntime(containerId: string): Promise<RuntimeStatus> {
    const container = this.docker.getContainer(containerId);
    await container.stop({ t: 5 }).catch(() => undefined);
    return this.getStatus(containerId);
  }

  async restartRuntime(containerId: string): Promise<RuntimeStatus> {
    const container = this.docker.getContainer(containerId);
    await container.restart({ t: 5 });
    return this.waitUntilReady(containerId);
  }

  async getStatus(containerId: string): Promise<RuntimeStatus> {
    const container = this.docker.getContainer(containerId);
    const inspect = await container.inspect();
    return {
      containerId,
      running: Boolean(inspect.State.Running),
      status: inspect.State.Status,
      exitCode: typeof inspect.State.ExitCode === 'number' ? inspect.State.ExitCode : null,
      port: readPublishedHostPort(inspect),
      imageTag: inspect.Config.Image,
    };
  }

  async destroyRuntime(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.remove({ force: true });
    console.log(`LaunchOS Runtime destroyed container ${containerId}`);
  }

  async getLogs(containerId: string, tail = 200): Promise<string> {
    const safeTail = Math.min(1000, Math.max(1, Math.trunc(tail) || 200));
    try {
      const result = await runDocker(['logs', '--tail', String(safeTail), containerId], {
        timeoutMs: 20_000,
      });
      return `${result.stdout}${result.stderr}`;
    } catch (error) {
      throw toRuntimeError(error, '读取运行日志失败');
    }
  }

  async checkHttp(url: string, timeoutMs = 45_000): Promise<HttpProbeResult> {
    const startedAt = Date.now();
    const deadline = Date.now() + timeoutMs;
    let lastError = 'no response';

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(4_000),
        });
        const body = (await response.text()).slice(0, 1000);
        if (response.status >= 200 && response.status < 400) {
          return {
            url,
            status: response.status,
            body,
            duration: Date.now() - startedAt,
          };
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'request failed';
      }
      await delay(1_000);
    }

    throw new RuntimeError(`Health check 失败：${url} (${lastError})`);
  }

  private async createMockRuntime(options: CreateRuntimeOptions): Promise<CreateRuntimeResult> {
    if (!options.artifactTar) {
      throw new RuntimeError('Mock Runtime 需要 artifactTar');
    }

    const containerPort = options.containerPort ?? DEFAULT_CONTAINER_PORT;
    await this.ensureImage(DEFAULT_IMAGE);

    const runtimeEnv = {
      ...(options.env ?? {}),
      PORT: String(containerPort),
    };
    const container = await this.docker.createContainer({
      Image: DEFAULT_IMAGE,
      name: `launchos-runtime-${randomUUID().slice(0, 8)}`,
      Cmd: START_COMMAND,
      WorkingDir: '/app',
      Env: Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`),
      ExposedPorts: {
        [`${containerPort}/tcp`]: {},
      },
      HostConfig: {
        Memory: MEMORY_LIMIT_BYTES,
        NanoCpus: CPU_LIMIT,
        Privileged: false,
        SecurityOpt: ['no-new-privileges'],
        PortBindings: {
          [`${containerPort}/tcp`]: [{ HostPort: '0' }],
        },
      },
      Labels: {
        'launchos.runtime': 'true',
        'launchos.runtime.mode': 'mock',
      },
    });

    await container.start();
    await this.putArtifact(container.id, options.artifactTar);
    console.log(`LaunchOS Mock Runtime created container ${container.id}`);
    return { containerId: container.id, mode: 'mock' };
  }

  private async createDockerRuntime(options: CreateRuntimeOptions): Promise<CreateRuntimeResult> {
    const contextPath = options.contextPath?.trim();
    if (!contextPath) {
      throw new RuntimeError('Docker Runtime 需要 contextPath');
    }
    if (!isDockerSupportedFramework(options.framework)) {
      throw new RuntimeError(`Docker Runtime 暂不支持 ${options.framework ?? 'UNKNOWN'}`);
    }

    const hasPrismaSchema =
      existsSync(join(contextPath, 'prisma', 'schema.prisma')) ||
      existsSync(join(contextPath, 'prisma', 'schema'));
    const files = generateDockerFiles({
      framework: options.framework ?? 'NODE',
      packageManager: options.packageManager,
      startCommand: options.startCommand,
      port: options.containerPort,
      buildArgKeys: Object.keys(options.buildEnv ?? {}),
      preInstallCopyPaths: resolvePreInstallCopyPaths({ hasPrismaSchema }),
      needsOpenssl: hasPrismaSchema,
    });
    const imageTag =
      options.imageTag?.trim() || `launchos-app:${randomUUID().slice(0, 8)}`;
    const containerPort = files.containerPort;
    const name = `launchos-runtime-${randomUUID().slice(0, 8)}`;

    await writeFile(join(contextPath, 'Dockerfile.launchos'), files.dockerfile, 'utf8');
    await writeFile(join(contextPath, '.dockerignore'), files.dockerignore, 'utf8');
    for (const [filename, content] of Object.entries(files.extraFiles)) {
      await writeFile(join(contextPath, filename), content, 'utf8');
    }

    const buildArgs = Object.entries(options.buildEnv ?? {}).flatMap(([key, value]) => [
      '--build-arg',
      `${key}=${value}`,
    ]);

    console.log(`LaunchOS Docker Runtime building ${imageTag} from ${contextPath}`);
    try {
      await runDocker(
        ['build', '-f', 'Dockerfile.launchos', ...buildArgs, '-t', imageTag, '.'],
        { cwd: contextPath, timeoutMs: 900_000 },
      );
    } catch (error) {
      throw toRuntimeError(error, `Docker build 失败：${imageTag}`);
    }

    let imageId: string | undefined;
    try {
      const inspect = await runDocker(['image', 'inspect', '--format', '{{.Id}}', imageTag], {
        timeoutMs: 30_000,
      });
      imageId = inspect.stdout.trim() || undefined;
    } catch {
      imageId = undefined;
    }

    const runtimeEnv: Record<string, string> = {
      ...(options.env ?? {}),
      PORT: String(containerPort),
      HOSTNAME: '0.0.0.0',
      HOST: '0.0.0.0',
      NODE_ENV: options.env?.NODE_ENV || 'production',
    };
    const envFlags = Object.entries(runtimeEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);

    try {
      await runDocker(
        [
          'run',
          '-d',
          '--name',
          name,
          '-p',
          `0:${containerPort}`,
          ...envFlags,
          '--memory',
          '512m',
          '--cpus',
          '1',
          '--label',
          'launchos.runtime=true',
          '--label',
          'launchos.runtime.mode=docker',
          imageTag,
        ],
        { timeoutMs: 60_000 },
      );
    } catch (error) {
      throw toRuntimeError(error, `Docker run 失败：${imageTag}`);
    }

    const inspect = await this.docker.getContainer(name).inspect();
    console.log(`LaunchOS Docker Runtime created container ${inspect.Id} image ${imageTag}`);
    return {
      containerId: inspect.Id,
      mode: 'docker',
      imageTag,
      imageId,
    };
  }

  private async waitUntilReady(containerId: string): Promise<RuntimeStatus> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await this.getStatus(containerId);
      if (!status.running) {
        throw new RuntimeError(`Runtime container ${containerId} exited before becoming ready`);
      }
      if (status.port != null) {
        return status;
      }
      await delay(400);
    }
    throw new RuntimeError(`Runtime container ${containerId} did not publish a host port`);
  }

  private async putArtifact(containerId: string, artifactTar: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.putArchive(createReadStream(artifactTar), { path: '/app' });
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      // Image is missing; pull it below.
    }

    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function createDocker(): Docker {
  if (process.platform === 'win32') {
    return new Docker({ socketPath: '//./pipe/docker_engine' });
  }
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

function readPublishedHostPort(inspect: {
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostPort: string }> | null | undefined>;
  };
}): number | null {
  const ports = inspect.NetworkSettings?.Ports ?? {};
  for (const bindings of Object.values(ports)) {
    if (!bindings) {
      continue;
    }
    for (const binding of bindings) {
      const parsed = Number(binding.HostPort);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function toRuntimeError(error: unknown, fallback: string): RuntimeError {
  if (error instanceof DockerCliError) {
    return new RuntimeError(error.message);
  }
  if (error instanceof Error) {
    return new RuntimeError(error.message || fallback);
  }
  return new RuntimeError(fallback);
}

export class RuntimeService extends LocalDockerRuntime {}

