import { mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ArtifactStatus,
  ArtifactType,
  CloudResourceStatus,
  CloudResourceType,
  Prisma,
  PrismaClient,
  RemoteDeploymentStatus,
} from '@launchos/database';
import { RemoteRunner, RemoteRunnerError } from '@launchos/remote-runner';
import { decryptCredential } from '@launchos/shared';
import { MinioArtifactStore } from '../artifacts/minio-artifact-store';
import { DeploymentEngineError } from '../engine/errors';

const SSH_RETRY_ATTEMPTS = 18;
const SSH_RETRY_DELAY_MS = 5_000;
const DOCKER_INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const CONTAINER_START_TIMEOUT_MS = 10 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 40_000;
const HEALTH_RETRY_MS = 2_000;

const INSTALL_DOCKER_COMMAND = [
  'set -eux',
  'export DEBIAN_FRONTEND=noninteractive',
  'if command -v docker >/dev/null 2>&1; then docker --version; exit 0; fi',
  'apt-get update -y',
  'apt-get install -y docker.io curl ca-certificates tar',
  'systemctl enable --now docker || service docker start || true',
  'docker --version',
].join('\n');

const START_CONTAINER_COMMAND = [
  'set -eux',
  'mkdir -p /opt/launchos/app',
  'tar -xf /opt/launchos/app.tar -C /opt/launchos/app',
  'ls -la /opt/launchos/app',
  'ls -la /opt/launchos/app/dist || true',
  'docker rm -f launchos-app || true',
  'docker pull node:20',
  "docker run -d --name launchos-app --restart unless-stopped -p 80:3000 -e PORT=3000 -v /opt/launchos/app:/app -w /app node:20 sh -c 'if [ -f /app/dist/index.js ]; then exec node /app/dist/index.js; elif [ -f /app/index.js ]; then exec node /app/index.js; else echo missing entry; ls -laR /app; exit 1; fi'",
  'sleep 2',
  'docker ps --filter name=launchos-app --format "{{.ID}} {{.Status}}"',
  'docker logs --tail 50 launchos-app || true',
].join('\n');

export type RemoteDeployResult = {
  remoteDeploymentId: string;
  status: 'SKIPPED' | 'RUNNING' | 'PENDING';
  publicUrl: string | null;
  reused?: boolean;
};

export class CloudRuntimeDeployer {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly artifactStore = new MinioArtifactStore(),
  ) {}

  async deployForPipeline(deploymentId: string): Promise<RemoteDeployResult> {
    const prepared = await this.prepare(deploymentId, false);
    if (prepared.status === 'SKIPPED' || !prepared.remoteDeploymentId) {
      return prepared;
    }
    if (prepared.reused) {
      return this.waitUntilSettled(prepared.remoteDeploymentId);
    }
    return this.runExisting(prepared.remoteDeploymentId);
  }

  async prepare(deploymentId: string, required: boolean): Promise<RemoteDeployResult> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, projectId: true },
    });
    if (!deployment) {
      throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
    }

    const inProgress = await this.prisma.remoteDeployment.findFirst({
      where: {
        deploymentId,
        status: {
          in: [
            RemoteDeploymentStatus.PENDING,
            RemoteDeploymentStatus.CONNECTING,
            RemoteDeploymentStatus.DEPLOYING,
          ],
        },
      },
      orderBy: { startedAt: 'desc' },
    });
    if (inProgress) {
      return {
        remoteDeploymentId: inProgress.id,
        status: 'PENDING',
        publicUrl: null,
        reused: true,
      };
    }

    const server = await this.findRunnableServer(deployment.projectId);
    if (!server) {
      if (required) {
        throw new DeploymentEngineError('No RUNNING cloud server with public IP is available');
      }
      return { remoteDeploymentId: '', status: 'SKIPPED', publicUrl: null };
    }

    const auth = readSshAuth(server.metadata);
    if (!auth) {
      if (required) {
        throw new DeploymentEngineError('Cloud server is missing SSH credentials');
      }
      return { remoteDeploymentId: '', status: 'SKIPPED', publicUrl: null };
    }

    const artifact = await this.prisma.artifact.findFirst({
      where: {
        deploymentId,
        type: ArtifactType.BUILD_OUTPUT,
        status: ArtifactStatus.READY,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!artifact) {
      throw new DeploymentEngineError('No READY artifact available to deploy');
    }

    const created = await this.prisma.remoteDeployment.create({
      data: {
        deploymentId,
        cloudResourceId: server.id,
        status: RemoteDeploymentStatus.PENDING,
        logs: '',
        startedAt: new Date(),
      },
      select: { id: true },
    });

    return {
      remoteDeploymentId: created.id,
      status: 'PENDING',
      publicUrl: null,
      reused: false,
    };
  }

  async runExisting(remoteDeploymentId: string): Promise<RemoteDeployResult> {
    const record = await this.prisma.remoteDeployment.findUnique({
      where: { id: remoteDeploymentId },
      include: {
        cloudResource: true,
      },
    });
    if (!record) {
      throw new DeploymentEngineError(`RemoteDeployment ${remoteDeploymentId} not found`);
    }

    if (
      record.status === RemoteDeploymentStatus.CONNECTING ||
      record.status === RemoteDeploymentStatus.DEPLOYING
    ) {
      return this.waitUntilSettled(record.id);
    }
    if (record.status === RemoteDeploymentStatus.RUNNING) {
      const publicUrl = record.cloudResource.publicIp
        ? `http://${record.cloudResource.publicIp}/`
        : null;
      return { remoteDeploymentId: record.id, status: 'RUNNING', publicUrl };
    }

    const claimed = await this.prisma.remoteDeployment.updateMany({
      where: {
        id: record.id,
        status: RemoteDeploymentStatus.PENDING,
      },
      data: { status: RemoteDeploymentStatus.CONNECTING },
    });
    if (claimed.count === 0) {
      return this.waitUntilSettled(record.id);
    }

    const auth = readSshAuth(record.cloudResource.metadata);
    if (!auth || !record.cloudResource.publicIp) {
      throw new DeploymentEngineError('Cloud server is missing SSH credentials or public IP');
    }

    const artifact = await this.prisma.artifact.findFirst({
      where: {
        deploymentId: record.deploymentId,
        type: ArtifactType.BUILD_OUTPUT,
        status: ArtifactStatus.READY,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!artifact) {
      throw new DeploymentEngineError('No READY artifact available to deploy');
    }

    try {
      await this.executeRemote(record.id, {
        host: record.cloudResource.publicIp,
        username: auth.username,
        password: auth.password,
        port: auth.port,
        storagePath: artifact.storagePath,
      });
      const publicUrl = `http://${record.cloudResource.publicIp}/`;
      await this.appendLog(record.id, `应用已在公网运行 ${publicUrl}`);
      await this.prisma.remoteDeployment.update({
        where: { id: record.id },
        data: {
          status: RemoteDeploymentStatus.RUNNING,
          finishedAt: new Date(),
        },
      });
      return { remoteDeploymentId: record.id, status: 'RUNNING', publicUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Remote deploy failed';
      await this.appendLog(record.id, `FAILED ${message}`);
      await this.prisma.remoteDeployment.update({
        where: { id: record.id },
        data: {
          status: RemoteDeploymentStatus.FAILED,
          finishedAt: new Date(),
        },
      });
      throw error;
    }
  }

  private async waitUntilSettled(remoteDeploymentId: string): Promise<RemoteDeployResult> {
    const deadline = Date.now() + DOCKER_INSTALL_TIMEOUT_MS + CONTAINER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const record = await this.prisma.remoteDeployment.findUnique({
        where: { id: remoteDeploymentId },
        include: { cloudResource: { select: { publicIp: true } } },
      });
      if (!record) {
        throw new DeploymentEngineError(`RemoteDeployment ${remoteDeploymentId} not found`);
      }
      if (record.status === RemoteDeploymentStatus.RUNNING) {
        const publicUrl = record.cloudResource.publicIp
          ? `http://${record.cloudResource.publicIp}/`
          : null;
        return { remoteDeploymentId: record.id, status: 'RUNNING', publicUrl };
      }
      if (record.status === RemoteDeploymentStatus.FAILED) {
        throw new DeploymentEngineError(record.logs.split('\n').at(-1) || 'Remote deploy failed');
      }
      await delay(2_000);
    }
    throw new DeploymentEngineError('Timed out waiting for remote deploy');
  }


  async checkPublicHealth(deploymentId: string): Promise<'SKIPPED' | 'OK'> {
    const remote = await this.prisma.remoteDeployment.findFirst({
      where: { deploymentId, status: RemoteDeploymentStatus.RUNNING },
      orderBy: { startedAt: 'desc' },
      include: {
        cloudResource: {
          select: { publicIp: true },
        },
      },
    });
    if (!remote?.cloudResource.publicIp) {
      return 'SKIPPED';
    }
    await this.waitForHttp(`http://${remote.cloudResource.publicIp}/`);
    return 'OK';
  }

  private async executeRemote(
    remoteId: string,
    input: {
      host: string;
      username: string;
      password: string;
      port: number;
      storagePath: string;
    },
  ): Promise<void> {
    const runner = new RemoteRunner();
    const tarPath = join(tmpdir(), 'launchos-remote', `${remoteId}.tar`);

    try {
      await this.prisma.remoteDeployment.update({
        where: { id: remoteId },
        data: { status: RemoteDeploymentStatus.CONNECTING },
      });
      await this.appendLog(remoteId, '连接服务器');
      await this.connectWithRetry(runner, {
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
      });
      await this.appendLog(remoteId, `SSH connected ${input.username}@${input.host}:${input.port}`);

      await this.prisma.remoteDeployment.update({
        where: { id: remoteId },
        data: { status: RemoteDeploymentStatus.DEPLOYING },
      });
      await this.appendLog(remoteId, '安装 Docker');
      await this.runRemoteCommand(runner, INSTALL_DOCKER_COMMAND, DOCKER_INSTALL_TIMEOUT_MS);

      await mkdir(dirname(tarPath), { recursive: true });
      await this.artifactStore.download(input.storagePath, tarPath);
      await this.runRemoteCommand(runner, 'mkdir -p /opt/launchos', 30_000);
      await this.appendLog(remoteId, '准备上传');
      await this.appendLog(remoteId, '上传中');
      try {
        await runner.upload(tarPath, '/opt/launchos/app.tar', { timeoutMs: 30 * 60 * 1000 });
        await this.appendLog(remoteId, '上传完成');
      } catch (error) {
        const message = error instanceof Error ? error.message : '上传失败';
        await this.appendLog(remoteId, `上传失败：${message}`);
        throw error;
      }

      await this.appendLog(remoteId, '启动 Container');
      await this.runRemoteCommand(runner, START_CONTAINER_COMMAND, CONTAINER_START_TIMEOUT_MS);

      await this.appendLog(remoteId, `健康检查 http://${input.host}/`);
      await this.waitForHttp(`http://${input.host}/`);
      await this.appendLog(remoteId, '健康检查通过');
    } finally {
      await runner.disconnect().catch(() => undefined);
      await unlink(tarPath).catch(() => undefined);
    }
  }

  private async connectWithRetry(
    runner: RemoteRunner,
    options: { host: string; port: number; username: string; password: string },
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SSH_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await runner.connect(options);
        return;
      } catch (error) {
        lastError = error;
        await runner.disconnect().catch(() => undefined);
        if (attempt < SSH_RETRY_ATTEMPTS) {
          await delay(SSH_RETRY_DELAY_MS);
        }
      }
    }
    const message = lastError instanceof Error ? lastError.message : 'SSH connect failed';
    throw new RemoteRunnerError(`SSH connect failed after retries: ${message}`);
  }

  private async runRemoteCommand(
    runner: RemoteRunner,
    command: string,
    timeoutMs: number,
  ): Promise<void> {
    const wrapped = `bash -lc ${JSON.stringify(command)}`;
    const result = await runner.execute(wrapped, { timeoutMs });
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.trim();
      throw new RemoteRunnerError(
        `Remote command failed with exit code ${result.exitCode}${output ? `: ${output.slice(0, 4000)}` : ''}`,
      );
    }
  }

  private async waitForHttp(url: string): Promise<void> {
    const startedAt = Date.now();
    let lastError = 'no response';
    while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        if (response.ok) {
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'request failed';
      }
      await delay(HEALTH_RETRY_MS);
    }
    throw new DeploymentEngineError(`Health check failed for ${url}: ${lastError}`);
  }

  private async findRunnableServer(projectId: string) {
    return this.prisma.cloudResource.findFirst({
      where: {
        projectId,
        type: CloudResourceType.SERVER,
        status: CloudResourceStatus.RUNNING,
        publicIp: { not: null },
        NOT: {
          publicIp: { in: ['127.0.0.1', 'localhost'] },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async appendLog(remoteId: string, line: string): Promise<void> {
    const current = await this.prisma.remoteDeployment.findUnique({
      where: { id: remoteId },
      select: { logs: true },
    });
    const next = current?.logs ? `${current.logs}\n${line}` : line;
    await this.prisma.remoteDeployment.update({
      where: { id: remoteId },
      data: { logs: next },
    });
  }
}

function readSshAuth(metadata: Prisma.JsonValue): {
  username: string;
  password: string;
  port: number;
} | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const encrypted = record.sshPasswordEncrypted;
  if (typeof encrypted !== 'string' || encrypted.length === 0) {
    return null;
  }
  const username = typeof record.sshUsername === 'string' && record.sshUsername.trim()
    ? record.sshUsername.trim()
    : 'root';
  const port = typeof record.sshPort === 'number' && Number.isInteger(record.sshPort)
    ? record.sshPort
    : 22;
  return {
    username,
    password: decryptCredential(encrypted),
    port,
  };
}
