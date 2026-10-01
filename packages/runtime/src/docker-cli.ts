import { spawn } from 'node:child_process';

export class DockerCliError extends Error {
  constructor(
    message: string,
    readonly stdout: string = '',
    readonly stderr: string = '',
  ) {
    super(message);
    this.name = 'DockerCliError';
  }
}

function resolveDockerBin(): string {
  const configured = process.env.DOCKER_BIN?.trim();
  if (configured) return configured;
  // Alpha colocated builder may only have podman (docker is often podman-docker).
  if (process.env.CONTAINER_RUNTIME?.trim().toLowerCase() === 'podman') {
    return 'podman';
  }
  return 'docker';
}

export function runDocker(
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = resolveDockerBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new DockerCliError(`${bin} ${args.join(' ')} 超时`, stdout, stderr));
    }, options.timeoutMs ?? 600_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      // Fall back to podman once if docker binary is missing on Alpha builder.
      if (bin === 'docker' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        void runDockerWithBin('podman', args, options).then(resolve, reject);
        return;
      }
      reject(new DockerCliError(error.message, stdout, stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = (stderr || stdout).trim().slice(-4000);
      reject(
        new DockerCliError(
          `${bin} ${args.join(' ')} 失败，exit code ${code}${detail ? `\n${detail}` : ''}`,
          stdout,
          stderr,
        ),
      );
    });
  });
}

function runDockerWithBin(
  bin: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new DockerCliError(`${bin} ${args.join(' ')} 超时`, stdout, stderr));
    }, options.timeoutMs ?? 600_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new DockerCliError(error.message, stdout, stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = (stderr || stdout).trim().slice(-4000);
      reject(
        new DockerCliError(
          `${bin} ${args.join(' ')} 失败，exit code ${code}${detail ? `\n${detail}` : ''}`,
          stdout,
          stderr,
        ),
      );
    });
  });
}
