import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import Docker from 'dockerode';
import type {
  CommandResult,
  CreateContainerOptions,
  HostCommandOptions,
  PackDirectoryOptions,
  RunNodeBuildOptions,
} from './types';

const DEFAULT_IMAGE = 'node:20';
const DEFAULT_WORKDIR = '/workspace';
const MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const CPU_LIMIT = 1_000_000_000;
const SANDBOX_SERVER_JS = [
  "const http = require('http');",
  'const port = Number(process.env.PORT || 3000);',
  'http.createServer((_req, res) => {',
  "  res.writeHead(200, { 'Content-Type': 'text/plain' });",
  "  res.end('LaunchOS runtime ok\\n');",
  '}).listen(port, () => {',
  "  console.log('listening on ' + port);",
  '});',
  '',
].join('\n');

const SANDBOX_PACKAGE_JSON = JSON.stringify(
  {
    name: 'launchos-sandbox',
    private: true,
    scripts: {
      build: 'mkdir -p dist && cp server.js dist/index.js && echo wrote dist/index.js',
    },
  },
  null,
  2,
);

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}

export class RunnerService {
  constructor(private readonly docker = createDocker()) {}

  async createContainer(options: CreateContainerOptions = {}): Promise<string> {
    const image = options.image ?? DEFAULT_IMAGE;
    const workdir = options.workdir ?? DEFAULT_WORKDIR;
    await this.ensureImage(image);

    const container = await this.docker.createContainer({
      Image: image,
      name: `launchos-build-${randomUUID().slice(0, 8)}`,
      Cmd: ['sh', '-c', `mkdir -p ${workdir} && sleep infinity`],
      WorkingDir: workdir,
      HostConfig: {
        Memory: MEMORY_LIMIT_BYTES,
        NanoCpus: CPU_LIMIT,
        Privileged: false,
        SecurityOpt: ['no-new-privileges'],
      },
      Labels: {
        'launchos.runner': 'true',
      },
    });

    await container.start();
    console.log(`LaunchOS Runner created container ${container.id}`);
    return container.id;
  }

  async executeCommand(options: HostCommandOptions): Promise<CommandResult>;
  async executeCommand(
    containerId: string,
    command: string[],
    options?: { cwd?: string },
  ): Promise<CommandResult>;
  async executeCommand(
    containerIdOrOptions: string | HostCommandOptions,
    command?: string[],
    options?: { cwd?: string },
  ): Promise<CommandResult> {
    if (typeof containerIdOrOptions === 'object') {
      return this.executeHostCommand(containerIdOrOptions);
    }
    return this.executeContainerCommand(containerIdOrOptions, command ?? [], options?.cwd);
  }

  private async executeHostCommand(options: HostCommandOptions): Promise<CommandResult> {
    const startedAt = Date.now();
    const cwd = options.cwd;
    const command = options.command.trim();
    if (!command) {
      throw new RunnerError('命令不能为空');
    }

    const env = {
      ...process.env,
      CI: 'true',
      ...options.env,
    };

    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        env,
        shell: true,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new RunnerError(`命令超时：${command}`));
      }, options.timeoutMs ?? 600_000);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(new RunnerError(error.message));
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        const exitCode = code ?? 1;
        const logs = [stdout, stderr].filter((item) => item.trim().length > 0).join('\n');
        resolve({
          command,
          cwd,
          exitCode,
          stdout,
          stderr,
          logs,
          duration: Date.now() - startedAt,
        });
      });
    });
  }

  private async executeContainerCommand(
    containerId: string,
    command: string[],
    cwd?: string,
  ): Promise<CommandResult> {
    const startedAt = Date.now();
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: cwd ?? DEFAULT_WORKDIR,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const collected = await this.collectStreams(stream);
    const inspect = await exec.inspect();
    const exitCode = inspect.ExitCode ?? 1;
    const logs = [collected.stdout, collected.stderr]
      .filter((item) => item.trim().length > 0)
      .join('\n');

    return {
      command: formatCommand(command),
      cwd: cwd ?? DEFAULT_WORKDIR,
      exitCode,
      stdout: collected.stdout,
      stderr: collected.stderr,
      logs,
      duration: Date.now() - startedAt,
    };
  }

  async packDirectory(options: PackDirectoryOptions): Promise<{ path: string; size: number }> {
    await mkdir(dirname(options.outputFile), { recursive: true });
    const sourcePath = options.sourcePath;
    const excludes = options.exclude ?? (options.contentsOnly ? ['.git'] : []);
    const excludeArgs = excludes.flatMap((item) => ['--exclude=' + item]);
    const args = options.contentsOnly
      ? ['-cf', options.outputFile, ...excludeArgs, '.']
      : ['-cf', options.outputFile, ...excludeArgs, '-C', dirname(sourcePath), basename(sourcePath)];
    const cwd = options.contentsOnly ? sourcePath : dirname(sourcePath);

    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', args, { cwd, windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        reject(new RunnerError(error.message));
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new RunnerError(stderr.trim() || '打包产物失败'));
      });
    });

    const info = await stat(options.outputFile);
    console.log(`LaunchOS Runner packed ${sourcePath} -> ${options.outputFile} (${info.size} bytes)`);
    return { path: options.outputFile, size: info.size };
  }

  async getLogs(containerId: string): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const buffer = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: false,
    });
    return decodeDockerLogs(buffer);
  }

  async destroyContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.remove({ force: true });
    console.log(`LaunchOS Runner destroyed container ${containerId}`);
  }

  async runNodeBuild(options: RunNodeBuildOptions = {}): Promise<CommandResult> {
    const startedAt = Date.now();
    const containerId = await this.createContainer();
    const command = 'npm install && npm run build';

    try {
      const seed = await this.executeCommand(containerId, [
        'sh',
        '-c',
        `echo '${Buffer.from(SANDBOX_PACKAGE_JSON).toString('base64')}' | base64 -d > ${DEFAULT_WORKDIR}/package.json && echo '${Buffer.from(SANDBOX_SERVER_JS).toString('base64')}' | base64 -d > ${DEFAULT_WORKDIR}/server.js`,
      ]);
      if (seed.exitCode !== 0) {
        throw new RunnerError(`Failed to prepare workspace\n${seed.logs}`);
      }

      const install = await this.executeCommand(containerId, ['npm', 'install']);
      const build =
        install.exitCode === 0
          ? await this.executeCommand(containerId, ['npm', 'run', 'build'])
          : null;
      const containerLogs = await this.getLogs(containerId);
      const logs = [install.logs, build?.logs, containerLogs]
        .filter((item): item is string => Boolean(item && item.trim().length > 0))
        .join('\n');
      const exitCode = build?.exitCode ?? install.exitCode;

      let artifactPath: string | undefined;
      let artifactSize: number | undefined;
      if (exitCode === 0 && options.outputFile) {
        const collected = await this.collectBuildOutput(containerId, options.outputFile);
        artifactPath = collected.path;
        artifactSize = collected.size;
      }

      return {
        command,
        cwd: DEFAULT_WORKDIR,
        exitCode,
        logs,
        stdout: logs,
        stderr: '',
        duration: Date.now() - startedAt,
        artifactPath,
        artifactSize,
      };
    } finally {
      await this.destroyContainer(containerId);
    }
  }

  async collectBuildOutput(
    containerId: string,
    outputFile: string,
  ): Promise<{ path: string; size: number }> {
    await mkdir(dirname(outputFile), { recursive: true });
    const container = this.docker.getContainer(containerId);
    const stream = await container.getArchive({ path: `${DEFAULT_WORKDIR}/dist` });
    await pipeline(stream, createWriteStream(outputFile));
    const info = await stat(outputFile);
    console.log(`LaunchOS Runner collected build output ${outputFile} (${info.size} bytes)`);
    return { path: outputFile, size: info.size };
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      // Image is missing; pull it below.
    }

    const stream = await this.docker.pull(image);
    await this.followProgress(stream);
  }

  private followProgress(stream: NodeJS.ReadableStream): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async collectStreams(stream: NodeJS.ReadableStream): Promise<{ stdout: string; stderr: string }> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    stdout.on('data', (chunk: Buffer) => {
      outChunks.push(chunk);
    });
    stderr.on('data', (chunk: Buffer) => {
      errChunks.push(chunk);
    });

    this.docker.modem.demuxStream(stream, stdout, stderr);
    await finished(stream);
    stdout.end();
    stderr.end();

    return {
      stdout: Buffer.concat(outChunks).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
    };
  }
}

function createDocker(): Docker {
  if (process.platform === 'win32') {
    return new Docker({ socketPath: '//./pipe/docker_engine' });
  }
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

function formatCommand(command: string[]): string {
  return command.join(' ');
}

function decodeDockerLogs(buffer: Buffer): string {
  if (buffer.length === 0) {
    return '';
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) {
      chunks.push(buffer.subarray(offset).toString('utf8'));
      break;
    }
    chunks.push(buffer.subarray(start, end).toString('utf8'));
    offset = end;
  }

  if (chunks.length === 0) {
    return buffer.toString('utf8');
  }
  return chunks.join('');
}
