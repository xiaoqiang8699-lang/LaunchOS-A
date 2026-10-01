import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteRunner, RemoteRunnerError } from '@launchos/remote-runner';
import { generateDockerFiles } from './dockerfile';
import { RuntimeError } from './runtime.service';
import type {
  CreateRuntimeOptions,
  CreateRuntimeResult,
  HttpProbeResult,
  RemoteBuildImageOptions,
  RemoteDockerExecResult,
  RemoteDockerProbe,
  RemoteRunContainerOptions,
  RemoteRunContainerResult,
  RemoteRuntimeConnection,
  RemoteUploadProgress,
  RuntimeProvider,
  RuntimeStatus,
} from './types';

const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export class RemoteDockerRuntime implements RuntimeProvider {
  readonly kind = 'remote' as const;

  constructor(private readonly connection: RemoteRuntimeConnection) {}

  async probe(): Promise<RemoteDockerProbe> {
    try {
      return await this.withRunner(async (runner) => {
        const os = await runner.execute(
          'if [ -f /etc/os-release ]; then . /etc/os-release; echo "$PRETTY_NAME"; else uname -srm; fi',
          { timeoutMs: 15_000 },
        );
        const osVersion = firstLine(os.stdout) || firstLine(os.stderr) || 'unknown';

        // Prefer docker-compatible CLI; Podman with docker alias is valid for managed ECS.
        const docker = await runner.execute("docker version --format '{{.Server.Version}}'", {
          timeoutMs: 20_000,
        });
        let dockerVersion = firstLine(docker.stdout);
        let runtimeLabel = 'docker';

        if (!(docker.exitCode === 0 && dockerVersion)) {
          const podman = await runner.execute('podman version --format {{.Server.Version}} 2>/dev/null || podman --version', {
            timeoutMs: 20_000,
          });
          const podmanVersion = firstLine(podman.stdout);
          if (podman.exitCode === 0 && podmanVersion) {
            dockerVersion = podmanVersion.replace(/^podman version\s+/i, '') || podmanVersion;
            runtimeLabel = 'podman';
          }
        }

        if (dockerVersion) {
          return {
            connected: true,
            osVersion,
            dockerVersion,
            dockerStatus: 'READY',
            stage: 'ready',
            canDeploy: true,
            summary: '可以部署',
            checks: ['服务器连接正常', `运行环境正常（${runtimeLabel}）`, '可以部署'],
          };
        }

        const missing =
          /not found|command not found|Cannot connect|Is the docker daemon running/i.test(
            `${docker.stdout}\n${docker.stderr}`,
          );
        return {
          connected: true,
          osVersion,
          dockerVersion: null,
          dockerStatus: missing ? 'MISSING' : 'ERROR',
          stage: 'runtime',
          canDeploy: false,
          summary: missing ? '服务器已连接，但运行环境尚未准备好' : '服务器已连接，但运行环境异常',
          checks: ['服务器连接正常', missing ? '运行环境未安装' : '运行环境异常', '暂时不能部署'],
          technicalDetail: firstLine(docker.stderr) || firstLine(docker.stdout) || undefined,
        };
      });
    } catch (error) {
      const technicalDetail = error instanceof Error ? error.message : '连接失败';
      throw new RuntimeError(toConnectionFailureMessage(technicalDetail));
    }
  }

  async execDocker(command: string): Promise<RemoteDockerExecResult> {
    const trimmed = command.trim();
    if (!trimmed) {
      throw new RuntimeError('docker 命令不能为空');
    }
    const full = trimmed.startsWith('docker ') ? trimmed : `docker ${trimmed}`;
    return this.withRunner(async (runner) => {
      const result = await runner.execute(full, { timeoutMs: 60_000 });
      return {
        command: full,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    });
  }

  async uploadArtifact(
    localTar: string,
    remoteDir: string,
    extraFiles: Record<string, string> = {},
    onProgress?: (progress: RemoteUploadProgress) => void | Promise<void>,
  ): Promise<{ contextPath: string }> {
    const dir = assertSafePath(remoteDir);
    const contextPath = `${dir}/app`;
    const remoteTar = `${dir}/app.tar`;

    await this.withRunner(async (runner) => {
      await onProgress?.({ phase: 'preparing', message: '准备上传' });
      const prepared = await runner.execute(`mkdir -p ${contextPath}`, { timeoutMs: 15_000 });
      if (prepared.exitCode !== 0) {
        throw new RuntimeError(prepared.stderr.trim() || '无法创建远程目录');
      }

      await onProgress?.({ phase: 'uploading', message: '上传中' });
      try {
        await runner.upload(localTar, remoteTar, { timeoutMs: UPLOAD_TIMEOUT_MS });
      } catch (error) {
        const detail = error instanceof Error ? error.message : '上传失败';
        if (/超时|timed out|timeout/i.test(detail)) {
          throw new RuntimeError(`上传超时（超过 30 分钟）：${detail}`);
        }
        throw new RuntimeError(`上传失败：${detail}`);
      }

      await onProgress?.({ phase: 'extracting', message: '正在整理上传文件' });
      const extracted = await runner.execute(`tar -xf ${remoteTar} -C ${contextPath}`, {
        timeoutMs: 120_000,
      });
      if (extracted.exitCode !== 0) {
        throw new RuntimeError(extracted.stderr.trim() || '远程解压制品失败');
      }

      if (Object.keys(extraFiles).length > 0) {
        const staging = await mkdtemp(join(tmpdir(), 'launchos-remote-files-'));
        for (const [filename, content] of Object.entries(extraFiles)) {
          const safeName = filename.replace(/\\/g, '/').split('/').pop();
          if (!safeName || safeName.includes('..')) {
            throw new RuntimeError(`非法远程文件名：${filename}`);
          }
          const localFile = join(staging, safeName);
          await writeFile(localFile, content, 'utf8');
          await runner.upload(localFile, `${contextPath}/${safeName}`, {
            timeoutMs: UPLOAD_TIMEOUT_MS,
          });
        }
      }

      await onProgress?.({ phase: 'completed', message: '上传完成' });
    });

    return { contextPath };
  }

  /**
   * Step 27.2 — upload a pre-built image archive (no extract / no remote build).
   */
  async uploadImageArchive(
    options: {
      localArchivePath: string;
      remoteDir: string;
      onProgress?: (progress: RemoteUploadProgress) => void | Promise<void>;
    },
  ): Promise<{ remoteArchivePath: string }> {
    const dir = assertSafePath(options.remoteDir);
    const remoteArchivePath = `${dir}/image.tar`;
    const localPath = options.localArchivePath;
    await this.withRunner(async (runner) => {
      await options.onProgress?.({ phase: 'preparing', message: '准备上传镜像归档' });
      const prepared = await runner.execute(`mkdir -p ${dir}`, { timeoutMs: 15_000 });
      if (prepared.exitCode !== 0) {
        throw new RuntimeError(prepared.stderr.trim() || '无法创建远程目录');
      }
      await options.onProgress?.({ phase: 'uploading', message: '上传镜像归档' });
      try {
        // Colocated Alpha: if the archive is already on a host-shared path (e.g.
        // LOCAL_ARTIFACT_ROOT mount), copy locally instead of SFTP looping to self.
        const visible = await runner.execute(
          `if [ -f ${shellSingleQuote(localPath)} ]; then echo COLO_VISIBLE; fi`,
          { timeoutMs: 15_000 },
        );
        if (String(visible.stdout || '').includes('COLO_VISIBLE')) {
          await options.onProgress?.({
            phase: 'uploading',
            message: '同机镜像归档本地拷贝',
          });
          const copied = await runner.execute(
            `cp -f ${shellSingleQuote(localPath)} ${shellSingleQuote(remoteArchivePath)} && chmod 644 ${shellSingleQuote(remoteArchivePath)}`,
            { timeoutMs: Math.min(UPLOAD_TIMEOUT_MS, 10 * 60 * 1000) },
          );
          if (copied.exitCode !== 0) {
            throw new RuntimeError(copied.stderr.trim() || '同机拷贝镜像归档失败');
          }
        } else {
          await runner.upload(localPath, remoteArchivePath, {
            timeoutMs: UPLOAD_TIMEOUT_MS,
          });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : '上传失败';
        if (/超时|timed out|timeout/i.test(detail)) {
          throw new RuntimeError(`上传超时（超过 30 分钟）：${detail}`);
        }
        throw new RuntimeError(`上传失败：${detail}`);
      }
      await options.onProgress?.({ phase: 'completed', message: '镜像归档上传完成' });
    });
    return { remoteArchivePath };
  }

  /**
   * Load a Docker/OCI image archive on the remote host (podman/docker load).
   * Never pulls from a registry.
   */
  async loadImageArchive(options: {
    remoteArchivePath: string;
    expectedImageTag?: string;
  }): Promise<{ loadedImageRef: string; imageId?: string }> {
    const remoteArchivePath = assertSafePath(options.remoteArchivePath);
    const load = await this.withRunner(async (runner) => {
      // Prefer docker CLI (podman docker-compat); fall back to podman load.
      const dockerLoad = await runner.execute(
        `docker load -i ${remoteArchivePath}`,
        { timeoutMs: 600_000 },
      );
      if (dockerLoad.exitCode === 0) {
        return dockerLoad;
      }
      return runner.execute(`podman load -i ${remoteArchivePath}`, { timeoutMs: 600_000 });
    });
    if (load.exitCode !== 0) {
      throw Object.assign(
        new RuntimeError(
          `DEPLOYABLE_IMAGE_NOT_LOADED: ${load.stderr.trim() || load.stdout.trim() || 'load failed'}`,
        ),
        { code: 'DEPLOYABLE_IMAGE_NOT_LOADED' },
      );
    }

    const fromStdout =
      /Loaded image(?:\(s\))?:\s*(.+)$/im.exec(`${load.stdout}\n${load.stderr}`)?.[1]?.trim() ||
      '';
    let loadedImageRef = fromStdout || options.expectedImageTag || '';
    if (!loadedImageRef) {
      throw Object.assign(
        new RuntimeError('DEPLOYABLE_IMAGE_NOT_LOADED: load 未返回 image ref'),
        { code: 'DEPLOYABLE_IMAGE_NOT_LOADED' },
      );
    }
    loadedImageRef = loadedImageRef.split(/\s+/)[0] || loadedImageRef;

    if (options.expectedImageTag && loadedImageRef !== options.expectedImageTag) {
      // Tag expected name if load returned a different digest/name.
      await this.withRunner(async (runner) => {
        await runner.execute(
          `docker tag ${loadedImageRef} ${assertSafeImageTag(options.expectedImageTag!)} || podman tag ${loadedImageRef} ${assertSafeImageTag(options.expectedImageTag!)}`,
          { timeoutMs: 30_000 },
        );
      });
      loadedImageRef = assertSafeImageTag(options.expectedImageTag);
    }

    const inspect = await this.withRunner(async (runner) =>
      runner.execute(
        `docker image inspect --format "{{.Id}}" ${loadedImageRef} 2>/dev/null || podman image inspect --format "{{.Id}}" ${loadedImageRef}`,
        { timeoutMs: 30_000 },
      ),
    );
    if (inspect.exitCode !== 0 || !firstLine(inspect.stdout)) {
      throw Object.assign(
        new RuntimeError('DEPLOYABLE_IMAGE_NOT_LOADED: load 后无法 inspect 镜像'),
        { code: 'DEPLOYABLE_IMAGE_NOT_LOADED' },
      );
    }

    return {
      loadedImageRef,
      imageId: firstLine(inspect.stdout) || undefined,
    };
  }

  async buildImage(options: RemoteBuildImageOptions): Promise<{ imageTag: string; imageId?: string }> {
    const contextPath = assertSafePath(options.contextPath);
    const imageTag = assertSafeImageTag(options.imageTag);
    const dockerfile = options.dockerfile ?? 'Dockerfile.launchos';
    const buildArgFlags = Object.entries(options.buildArgs ?? {})
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .map(([key, value]) => `--build-arg ${key}=${shellSingleQuote(value)}`)
      .join(' ');
    const result = await this.withRunner(async (runner) => {
      const script = `cd ${contextPath} && docker build -f ${dockerfile} ${buildArgFlags} -t ${imageTag} .`.replace(
        /\s+/g,
        ' ',
      );
      return runner.execute(`sh -c ${JSON.stringify(script)}`, { timeoutMs: 900_000 });
    });
    if (result.exitCode !== 0) {
      throw new RuntimeError(result.stderr.trim() || `Docker build 失败：${imageTag}`);
    }

    const inspect = await this.withRunner(async (runner) => {
      return runner.execute(`docker image inspect --format "{{.Id}}" ${imageTag}`, {
        timeoutMs: 30_000,
      });
    });
    return {
      imageTag,
      imageId: firstLine(inspect.stdout) || undefined,
    };
  }

  async runContainer(options: RemoteRunContainerOptions): Promise<RemoteRunContainerResult> {
    const imageTag = assertSafeImageTag(options.imageTag);
    const name = assertSafePath(options.name);
    const internalPort = options.internalPort;
    if (!Number.isInteger(internalPort) || internalPort <= 0) {
      throw new RuntimeError('internalPort 无效');
    }

    const envFilePath = `/tmp/launchos-env-${name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}-${Date.now()}`;
    const envEntries: Record<string, string> = {
      ...(options.env ?? {}),
      // Managed values always win over user overrides.
      PORT: String(internalPort),
      HOSTNAME: '0.0.0.0',
      HOST: '0.0.0.0',
      NODE_ENV: options.env?.NODE_ENV || 'production',
    };
    const publishHost = options.publishHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
    if (publishHost !== '127.0.0.1') {
      throw Object.assign(
        new RuntimeError('RUNTIME_PUBLIC_BIND_FORBIDDEN: 运行端口必须绑定 127.0.0.1，禁止公网暴露动态端口'),
        { code: 'RUNTIME_PUBLIC_BIND_FORBIDDEN' },
      );
    }
    const reserved = new Set(
      (options.reservedHostPorts ?? []).filter((p) => Number.isInteger(p) && p > 0),
    );

    const started = await this.withRunner(async (runner) => {
      await runner.execute(`docker rm -f ${name}`, { timeoutMs: 30_000 });

      let hostPort = options.hostPort;
      if (hostPort != null) {
        if (
          !Number.isInteger(hostPort) ||
          hostPort < 39000 ||
          hostPort > 39999 ||
          hostPort === internalPort
        ) {
          throw new RuntimeError('hostPort 无效：必须使用 39000–39999，且不能等于 containerPort');
        }
      } else {
        // Never prefer containerPort as hostPort (avoids binding 80/3000 on the host).
        const preferred = Array.from({ length: 1000 }, (_, i) => 39000 + i);
        hostPort = preferred[0];
        for (const candidate of preferred) {
          if (reserved.has(candidate) || candidate === internalPort) {
            continue;
          }
          const probe = await runner.execute(
            `ss -lnt 2>/dev/null | awk '{print $4}' | grep -E '[:.]${candidate}$' || true`,
            { timeoutMs: 10_000 },
          );
          if (!firstLine(probe.stdout)) {
            hostPort = candidate;
            break;
          }
        }
      }

      const labelFlags = Object.entries({
        'launchos.managed': 'true',
        'launchos.runtime': 'true',
        'launchos.runtime.mode': 'remote',
        ...(options.labels ?? {}),
      })
        .filter(([key, value]) => /^[a-z0-9._-]+$/i.test(key) && /^[\w.:@/-]+$/.test(value))
        .map(([key, value]) => `--label ${key}=${value}`)
        .join(' ');

      const envFileBody = Object.entries(envEntries)
        .map(([key, value]) => `${key}=${escapeEnvFileValue(value)}`)
        .join('\n');

      try {
        await runner.writeTextFile(envFilePath, `${envFileBody}\n`, 0o600);
        return await runner.execute(
          [
            'docker run -d',
            `--name ${name}`,
            '--restart=unless-stopped',
            `--pull=${options.pullPolicy === 'always' ? 'always' : options.pullPolicy === 'missing' ? 'missing' : 'never'}`,
            `-p ${publishHost}:${hostPort}:${internalPort}`,
            `--env-file ${envFilePath}`,
            '--memory 512m',
            '--cpus 1',
            labelFlags,
            imageTag,
          ]
            .filter(Boolean)
            .join(' '),
          { timeoutMs: 60_000 },
        );
      } finally {
        await runner.execute(`rm -f ${envFilePath}`, { timeoutMs: 10_000 }).catch(() => undefined);
      }
    });
    if (started.exitCode !== 0) {
      const detail = started.stderr.trim() || `Docker run 失败：${imageTag}`;
      if (/pull.*denied|registry-1\.docker\.io|docker\.io|short-name|resolving.*image/i.test(detail)) {
        throw Object.assign(
          new RuntimeError(`DEPLOYABLE_IMAGE_NOT_LOADED: ${detail}`),
          { code: 'DEPLOYABLE_IMAGE_NOT_LOADED' },
        );
      }
      if (/address already in use|EADDRINUSE|bind:/i.test(detail)) {
        throw new RuntimeError('服务器运行资源暂时冲突，请重新尝试上线。');
      }
      throw new RuntimeError(detail);
    }

    const containerId = firstLine(started.stdout);
    if (!containerId) {
      throw new RuntimeError('Docker run 未返回 containerId');
    }

    const status = await this.waitUntilReady(containerId);
    if (status.port == null) {
      throw new RuntimeError('远程容器未发布端口');
    }

    const inspect = await this.execDocker(`image inspect --format "{{.Id}}" ${imageTag}`);
    return {
      containerId,
      imageTag,
      imageId: firstLine(inspect.stdout) || undefined,
      externalPort: status.port,
      internalPort,
    };
  }

  /** Host ports currently LISTEN on the remote server (no secrets). */
  async listListeningHostPorts(): Promise<number[]> {
    const probe = await this.withRunner(async (runner) =>
      runner.execute(`ss -lnt 2>/dev/null | awk '{print $4}' || true`, { timeoutMs: 15_000 }),
    );
    const ports = new Set<number>();
    for (const line of (probe.stdout || '').split(/\r?\n/)) {
      const match = line.trim().match(/[:.](\d+)$/);
      if (!match?.[1]) continue;
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0) {
        ports.add(port);
      }
    }
    return [...ports];
  }

  /** List LaunchOS-managed container IDs (by label). */
  async listManagedContainerIds(): Promise<
    Array<{ id: string; name: string; labels: Record<string, string> }>
  > {
    const listed = await this.execDocker(
      `ps -a --filter label=launchos.managed=true --format "{{.ID}}|{{.Names}}"`,
    );
    if (listed.exitCode !== 0 || !listed.stdout?.trim()) {
      return [];
    }
    const rows: Array<{ id: string; name: string; labels: Record<string, string> }> = [];
    for (const line of listed.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const [id, name] = line.split('|');
      if (!id) continue;
      const inspect = await this.execDocker(
        `inspect --format "{{index .Config.Labels \\"launchos.projectId\\"}}|{{index .Config.Labels \\"launchos.deployableUnitId\\"}}|{{index .Config.Labels \\"launchos.deploymentId\\"}}|{{index .Config.Labels \\"launchos.serviceInstanceId\\"}}" ${id}`,
      );
      const [projectId, deployableUnitId, deploymentId, serviceInstanceId] = (
        firstLine(inspect.stdout) || ''
      ).split('|');
      rows.push({
        id,
        name: name || '',
        labels: {
          'launchos.projectId': projectId || '',
          'launchos.deployableUnitId': deployableUnitId || '',
          'launchos.deploymentId': deploymentId || '',
          'launchos.serviceInstanceId': serviceInstanceId || '',
        },
      });
    }
    return rows;
  }

  async stopContainer(containerId: string): Promise<void> {
    const id = assertSafePath(containerId);
    const result = await this.execDocker(`stop ${id}`);
    if (result.exitCode !== 0) {
      throw new RuntimeError(result.stderr.trim() || '停止容器失败');
    }
  }

  async getContainerStatus(containerId: string): Promise<RuntimeStatus> {
    const id = assertSafePath(containerId);
    const inspect = await this.withRunner(async (runner) => {
      return runner.execute(
        `docker inspect --format "{{.State.Running}}|{{.State.Status}}|{{.State.ExitCode}}|{{.Id}}|{{json .NetworkSettings.Ports}}" ${id}`,
        { timeoutMs: 20_000 },
      );
    });
    if (inspect.exitCode !== 0) {
      throw new RuntimeError(inspect.stderr.trim() || `无法读取容器状态：${id}`);
    }

    const [runningRaw, status, exitCodeRaw, fullId, portsRaw] = (firstLine(inspect.stdout) || '').split('|');
    const exitCode = Number(exitCodeRaw);
    return {
      containerId: fullId || id,
      running: runningRaw === 'true',
      status: status || 'unknown',
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      port: readPublishedPort(portsRaw ?? ''),
    };
  }

  /**
   * Return container env KEY names only (never values) for injection verification.
   */
  async listContainerEnvKeys(containerId: string): Promise<string[]> {
    const id = assertSafePath(containerId);
    const inspect = await this.withRunner(async (runner) => {
      return runner.execute(
        `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${id}`,
        { timeoutMs: 20_000 },
      );
    });
    if (inspect.exitCode !== 0) {
      throw new RuntimeError(inspect.stderr.trim() || `无法读取容器环境变量键：${id}`);
    }
    const keys: string[] = [];
    for (const line of String(inspect.stdout || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      const key = eq >= 0 ? trimmed.slice(0, eq) : trimmed;
      if (key) keys.push(key);
    }
    return keys;
  }

  async createRuntime(options: CreateRuntimeOptions): Promise<CreateRuntimeResult> {
    if (!options.artifactTar) {
      throw new RuntimeError('RemoteDockerRuntime 需要 artifactTar');
    }
    const framework = options.framework ?? 'NODE';
    const files = generateDockerFiles({
      framework,
      packageManager: options.packageManager,
      startCommand: options.startCommand,
      port: options.containerPort,
    });
    const imageTag = options.imageTag?.trim() || `launchos-app:${Date.now().toString(36)}`;
    const remoteDir = `/opt/launchos/${imageTag.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    const uploaded = await this.uploadArtifact(options.artifactTar, remoteDir, {
      'Dockerfile.launchos': files.dockerfile,
      '.dockerignore': files.dockerignore,
      ...files.extraFiles,
    });
    const built = await this.buildImage({
      contextPath: uploaded.contextPath,
      imageTag,
      dockerfile: 'Dockerfile.launchos',
    });
    const started = await this.runContainer({
      imageTag: built.imageTag,
      name: `launchos-${imageTag.replace(/[^a-z0-9]+/gi, '').slice(-12) || 'app'}`,
      internalPort: files.containerPort,
    });
    return {
      containerId: started.containerId,
      mode: 'docker',
      imageTag: built.imageTag,
      imageId: built.imageId ?? started.imageId,
    };
  }

  async startRuntime(containerId: string): Promise<RuntimeStatus> {
    const id = assertSafePath(containerId);
    await this.execDocker(`start ${id}`).catch(() => undefined);
    return this.waitUntilReady(id);
  }

  async stopRuntime(containerId: string): Promise<RuntimeStatus> {
    await this.stopContainer(containerId).catch(() => undefined);
    return this.getContainerStatus(containerId);
  }

  async restartRuntime(containerId: string): Promise<RuntimeStatus> {
    const id = assertSafePath(containerId);
    const result = await this.execDocker(`restart ${id}`);
    if (result.exitCode !== 0) {
      throw new RuntimeError(result.stderr.trim() || '重启容器失败');
    }
    return this.waitUntilReady(id);
  }

  async getStatus(containerId: string): Promise<RuntimeStatus> {
    return this.getContainerStatus(containerId);
  }

  async destroyRuntime(containerId: string): Promise<void> {
    const id = assertSafePath(containerId);
    await this.execDocker(`rm -f ${id}`);
  }

  async getLogs(containerId: string, tail = 200): Promise<string> {
    const id = assertSafePath(containerId);
    const safeTail = Math.min(1000, Math.max(1, Math.trunc(tail) || 200));
    const result = await this.execDocker(`logs --tail ${safeTail} ${id}`);
    if (result.exitCode !== 0) {
      throw new RuntimeError(result.stderr.trim() || '读取运行日志失败');
    }
    return `${result.stdout}${result.stderr}`;
  }

  /**
   * Remote health checks always probe from inside the target server.
   * Dynamic unit ports (39000+) must not rely on public reachability.
   */
  async checkHttp(url: string, timeoutMs = 45_000): Promise<HttpProbeResult> {
    const startedAt = Date.now();
    const deadline = Date.now() + timeoutMs;
    const localUrl = toServerLocalProbeUrl(url);
    let lastError = 'no response';

    while (Date.now() < deadline) {
      try {
        const probe = await this.probeHttpOnServer(localUrl, 4_000);
        if (probe.status >= 200 && probe.status < 400) {
          return {
            url: localUrl,
            status: probe.status,
            body: probe.body,
            duration: Date.now() - startedAt,
          };
        }
        lastError = `HTTP ${probe.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'request failed';
      }
      await delay(1_000);
    }

    throw new RuntimeError(`Health check 失败：${localUrl} (${lastError})`);
  }

  private async probeHttpOnServer(
    url: string,
    perAttemptTimeoutMs: number,
  ): Promise<{ status: number; body: string }> {
    const script = [
      'python3 - <<\'PY\'',
      'import json,urllib.error,urllib.request',
      `url=${JSON.stringify(url)}`,
      `timeout=${Math.max(1, Math.floor(perAttemptTimeoutMs / 1000))}`,
      'try:',
      '  with urllib.request.urlopen(url, timeout=timeout) as r:',
      '    body=r.read(1000).decode("utf-8","replace")',
      '    print(json.dumps({"ok":True,"status":int(getattr(r,"status",200)),"body":body}))',
      'except urllib.error.HTTPError as e:',
      '  body=(e.read(1000) if hasattr(e,"read") else b"").decode("utf-8","replace")',
      '  print(json.dumps({"ok":False,"status":int(e.code),"body":body or str(e)}))',
      'except Exception as e:',
      '  print(json.dumps({"ok":False,"status":0,"body":str(e)[:500]}))',
      'PY',
    ].join('\n');

    return this.withRunner(async (runner) => {
      const result = await runner.execute(script, {
        timeoutMs: perAttemptTimeoutMs + 8_000,
      });
      const line = firstLine(result.stdout) || firstLine(result.stderr);
      if (!line) {
        throw new RuntimeError(result.stderr.trim() || '服务器内部健康检查无响应');
      }
      let parsed: { ok?: boolean; status?: number; body?: string };
      try {
        parsed = JSON.parse(line) as { ok?: boolean; status?: number; body?: string };
      } catch {
        throw new RuntimeError(`服务器内部健康检查输出无效：${line.slice(0, 200)}`);
      }
      const status = Number(parsed.status) || 0;
      const body = String(parsed.body ?? '').slice(0, 1000);
      if (!parsed.ok && status < 200) {
        throw new RuntimeError(body || '服务器内部健康检查失败');
      }
      return { status: status || 0, body };
    });
  }

  private async waitUntilReady(containerId: string): Promise<RuntimeStatus> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = await this.getContainerStatus(containerId);
      if (!status.running) {
        throw new RuntimeError(`远程容器 ${containerId} 在就绪前退出`);
      }
      if (status.port != null) {
        return status;
      }
      await delay(400);
    }
    throw new RuntimeError(`远程容器 ${containerId} 未发布端口`);
  }

  private async withRunner<T>(fn: (runner: RemoteRunner) => Promise<T>): Promise<T> {
    const runner = new RemoteRunner();
    try {
      await runner.connect({
        host: this.connection.host,
        port: this.connection.port,
        username: this.connection.username,
        password: this.connection.password,
        readyTimeoutMs: this.connection.readyTimeoutMs ?? 20_000,
      });
      return await fn(runner);
    } catch (error) {
      if (error instanceof RuntimeError) {
        throw error;
      }
      const detail =
        error instanceof RemoteRunnerError || error instanceof Error
          ? error.message
          : '远程连接失败';
      throw new RuntimeError(toConnectionFailureMessage(detail));
    } finally {
      await runner.disconnect().catch(() => undefined);
    }
  }
}

function toConnectionFailureMessage(detail: string): string {
  return [
    '服务器无法连接',
    '',
    '请检查：',
    '- IP',
    '- 端口',
    '- 账号',
    '- 密码',
    '- 防火墙',
    '',
    `技术信息：${detail}`,
  ].join('\n');
}

function firstLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Rewrite any host:port URL to loopback so probes never require public unit ports. */
function toServerLocalProbeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    return `http://127.0.0.1:${port}${path}`;
  } catch {
    return url;
  }
}

function assertSafePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9/._:-]+$/.test(trimmed)) {
    throw new RuntimeError(`非法远程路径：${value}`);
  }
  return trimmed;
}

function assertSafeImageTag(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || !/^[a-z0-9][a-z0-9./:_-]*$/.test(trimmed)) {
    throw new RuntimeError(`非法镜像标签：${value}`);
  }
  return trimmed;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Escape value for Docker --env-file (KEY=value lines). */
function escapeEnvFileValue(value: string): string {
  if (/[\s#"']/.test(value) || value.includes('\n')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}

function readPublishedPort(raw: string): number | null {
  if (!raw || raw === '<no value>' || raw === 'null') {
    return null;
  }
  try {
    const ports = JSON.parse(raw) as Record<string, Array<{ HostPort?: string }> | null>;
    for (const bindings of Object.values(ports ?? {})) {
      const hostPort = bindings?.[0]?.HostPort;
      const parsed = Number(hostPort);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  } catch {
    const matched = raw.match(/"HostPort"\s*:\s*"(\d+)"/);
    if (matched?.[1]) {
      return Number(matched[1]);
    }
  }
  return null;
}
