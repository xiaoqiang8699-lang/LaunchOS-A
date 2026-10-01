/**
 * Step 27.2 — Build & save container images on LaunchOS builder (not on managed ECS).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  generateDockerFiles,
  isDockerSupportedFramework,
  resolvePreInstallCopyPaths,
} from './dockerfile.js';
import { DockerCliError, runDocker } from './docker-cli.js';
import { RuntimeError } from './runtime.service.js';

export const MANAGED_BASE_IMAGE = 'node:20-alpine';
export const RUNTIME_PULL_POLICY_NEVER = 'never' as const;

export type BuiltImageArchive = {
  imageTag: string;
  imageId: string | null;
  archivePath: string;
  size: number;
  checksumSha256: string;
  architecture: string;
  os: string;
  containerPort: number;
  cmd: string[];
  entrypoint: string[];
};

export type BuildImageArchiveInput = {
  contextPath: string;
  framework: string;
  packageManager?: string | null;
  startCommand: string;
  containerPort?: number | null;
  imageTag: string;
  /** Public build-time env only — never secrets. */
  buildEnv?: Record<string, string>;
  archivePath?: string;
};

/**
 * Build image on the LaunchOS builder host and `docker save` to a tar archive.
 * Does not run on managed ECS.
 */
export async function buildAndSaveImageArchive(
  input: BuildImageArchiveInput,
): Promise<BuiltImageArchive> {
  if (!isDockerSupportedFramework(input.framework)) {
    throw new RuntimeError(`Docker image build 暂不支持 ${input.framework}`);
  }
  const frameworkUpper = input.framework.toUpperCase();
  // Vite/static images embed their own CMD; Node/Nest still need a resolved start command.
  if (frameworkUpper !== 'VITE' && !input.startCommand?.trim()) {
    throw new RuntimeError('ARTIFACT_NOT_RUNNABLE: missing resolved start command');
  }

  await assertLocalBaseImagePresent(MANAGED_BASE_IMAGE);

  const hasPrismaSchema =
    existsSync(join(input.contextPath, 'prisma', 'schema.prisma')) ||
    existsSync(join(input.contextPath, 'prisma', 'schema'));
  const preInstallCopyPaths = resolvePreInstallCopyPaths({ hasPrismaSchema });

  const files = generateDockerFiles({
    framework: input.framework,
    packageManager: input.packageManager,
    startCommand: input.startCommand,
    port: input.containerPort,
    buildArgKeys: Object.keys(input.buildEnv ?? {}),
    preInstallCopyPaths,
    needsOpenssl: hasPrismaSchema,
  });

  await writeFile(join(input.contextPath, 'Dockerfile.launchos'), files.dockerfile, 'utf8');
  await writeFile(join(input.contextPath, '.dockerignore'), files.dockerignore, 'utf8');
  for (const [filename, content] of Object.entries(files.extraFiles)) {
    await writeFile(join(input.contextPath, filename), content, 'utf8');
  }

  const imageTag = assertSafeLocalImageTag(input.imageTag);
  const buildArgs = Object.entries(input.buildEnv ?? {}).flatMap(([key, value]) => [
    '--build-arg',
    `${key}=${value}`,
  ]);

  try {
    await runDocker(
      ['build', '-f', 'Dockerfile.launchos', ...buildArgs, '-t', imageTag, '.'],
      { cwd: input.contextPath, timeoutMs: 900_000 },
    );
  } catch (error) {
    throw classifyLocalBuildError(error, imageTag);
  }

  let imageId: string | null = null;
  let architecture = 'amd64';
  let os = 'linux';
  let cmd: string[] = [];
  let entrypoint: string[] = [];
  try {
    const inspect = await runDocker(
      [
        'image',
        'inspect',
        '--format',
        '{{.Id}}|{{.Architecture}}|{{.Os}}|{{json .Config.Cmd}}|{{json .Config.Entrypoint}}',
        imageTag,
      ],
      { timeoutMs: 30_000 },
    );
    const [id, arch, imageOs, cmdJson, entryJson] = inspect.stdout.trim().split('|');
    imageId = id || null;
    architecture = (arch || 'amd64').toLowerCase();
    os = (imageOs || 'linux').toLowerCase();
    try {
      cmd = JSON.parse(cmdJson || '[]') as string[];
    } catch {
      cmd = [];
    }
    try {
      entrypoint = JSON.parse(entryJson || 'null') as string[] | null ?? [];
    } catch {
      entrypoint = [];
    }
  } catch {
    // keep defaults
  }

  const archivePath =
    input.archivePath ||
    join(tmpdir(), 'launchos-image-archives', `${imageTag.replace(/[/:]/g, '_')}.tar`);
  await mkdir(dirname(archivePath), { recursive: true });
  try {
    await runDocker(['save', '-o', archivePath, imageTag], { timeoutMs: 600_000 });
  } catch (error) {
    throw toArchiveError(error, `docker save 失败：${imageTag}`);
  }

  const size = (await stat(archivePath)).size;
  const checksumSha256 = await sha256File(archivePath);

  return {
    imageTag,
    imageId,
    archivePath,
    size,
    checksumSha256,
    architecture,
    os,
    containerPort: files.containerPort,
    cmd,
    entrypoint,
  };
}

export async function assertLocalBaseImagePresent(image: string): Promise<void> {
  try {
    await runDocker(['image', 'inspect', image], { timeoutMs: 15_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new RuntimeError(
        `BASE_IMAGE_MISSING: builder 缺少基础镜像 ${image}，请在 BUILD 基础设施预热（勿在托管 ECS 拉取）。${detail.slice(0, 200)}`,
      ),
      { code: 'BASE_IMAGE_MISSING' },
    );
  }
}

export async function inspectLocalImageArchitecture(image: string): Promise<{
  architecture: string;
  os: string;
  present: boolean;
}> {
  try {
    const inspect = await runDocker(
      ['image', 'inspect', '--format', '{{.Architecture}}|{{.Os}}', image],
      { timeoutMs: 15_000 },
    );
    const [architecture, os] = inspect.stdout.trim().split('|');
    return {
      architecture: (architecture || 'amd64').toLowerCase(),
      os: (os || 'linux').toLowerCase(),
      present: true,
    };
  } catch {
    return { architecture: 'unknown', os: 'unknown', present: false };
  }
}

function classifyLocalBuildError(error: unknown, imageTag: string): RuntimeError {
  const text =
    error instanceof DockerCliError
      ? `${error.message}\n${error.stderr}\n${error.stdout}`
      : error instanceof Error
        ? error.message
        : String(error);
  if (/registry-1\.docker\.io|docker\.io\/library|pull access denied|toomanyrequests|EOF|i\/o timeout|connection reset|TLS handshake|no such host|lookup.*docker/i.test(text)) {
    return Object.assign(
      new RuntimeError(`CONTAINER_REGISTRY_UNREACHABLE: builder 无法拉取基础镜像\n${text.slice(0, 800)}`),
      { code: 'CONTAINER_REGISTRY_UNREACHABLE' },
    );
  }
  if (/failed to resolve|pulling from|manifest unknown|BASE_IMAGE/i.test(text)) {
    return Object.assign(
      new RuntimeError(`BASE_IMAGE_PULL_FAILED: ${text.slice(0, 800)}`),
      { code: 'BASE_IMAGE_PULL_FAILED' },
    );
  }
  if (
    /RUN npm install|RUN pnpm install|RUN yarn install|npm error|npm ERR!|pnpm ERR|yarn error|prisma generate|Could not find Prisma Schema|ERESOLVE|ETARGET|ENOENT.*package/i.test(
      text,
    )
  ) {
    return Object.assign(
      new RuntimeError(`DEPENDENCY_INSTALL_FAILED: ${text.slice(0, 2000)}`),
      { code: 'DEPENDENCY_INSTALL_FAILED' },
    );
  }
  if (/docker build|podman build|building at STEP/i.test(text)) {
    return Object.assign(
      new RuntimeError(`BUILD_IMAGE_FAILED: ${text.slice(0, 2000)}`),
      { code: 'BUILD_IMAGE_FAILED' },
    );
  }
  return toArchiveError(error, `Docker build 失败：${imageTag}`);
}

function toArchiveError(error: unknown, fallback: string): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (error instanceof DockerCliError) {
    return new RuntimeError(error.message || fallback);
  }
  return new RuntimeError(error instanceof Error ? error.message : fallback);
}

function assertSafeLocalImageTag(tag: string): string {
  const value = tag.trim();
  if (!/^[a-z0-9._/-]+:[a-z0-9._-]+$/i.test(value)) {
    throw new RuntimeError(`非法 imageTag：${tag}`);
  }
  return value;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
