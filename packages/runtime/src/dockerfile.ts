export type DockerfileInput = {
  framework: string;
  packageManager?: string | null;
  startCommand?: string | null;
  port?: number | null;
  /** Public build-time ARG keys only (e.g. NEXT_PUBLIC_*). Never secrets. */
  buildArgKeys?: string[];
  /**
   * Context-relative directories/files that must exist before `npm/pnpm/yarn install`
   * (e.g. `prisma` for `postinstall: prisma generate`).
   */
  preInstallCopyPaths?: string[];
  /** When true, install OpenSSL on alpine for Prisma engines. */
  needsOpenssl?: boolean;
};

export type GeneratedDockerFiles = {
  dockerfile: string;
  dockerignore: string;
  extraFiles: Record<string, string>;
  containerPort: number;
  runtime: string;
};

const DOCKERIGNORE = `node_modules
.git
*.log
.DS_Store
`;

export function isDockerSupportedFramework(framework: string | null | undefined): boolean {
  const value = framework?.toUpperCase();
  return value === 'NEXTJS' || value === 'VITE' || value === 'NODE' || value === 'NESTJS';
}

/**
 * Paths that postinstall / prepare scripts commonly need before dependency install.
 * Callers should only pass paths that exist in the build context.
 */
export function resolvePreInstallCopyPaths(flags: {
  hasPrismaSchema?: boolean;
}): string[] {
  const paths: string[] = [];
  if (flags.hasPrismaSchema) {
    paths.push('prisma');
  }
  return paths;
}

function preInstallCopyLines(paths?: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths ?? []) {
    const path = String(raw || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\.\./g, '');
    if (!path || path.includes('..')) continue;
    if (path === 'prisma' || path.endsWith('/prisma')) {
      out.push('COPY prisma ./prisma');
      continue;
    }
    // Only allow simple relative segments (no shell metacharacters).
    if (!/^[A-Za-z0-9._/-]+$/.test(path)) continue;
    out.push(`COPY ${path} ./${path}`);
  }
  return out;
}

function alpineOpensslLines(needed?: boolean): string[] {
  if (!needed) return [];
  // Prisma engines on alpine need OpenSSL; libc6-compat helps native modules.
  return ['RUN apk add --no-cache libc6-compat openssl'];
}

export function generateDockerFiles(input: DockerfileInput): GeneratedDockerFiles {
  const framework = input.framework.toUpperCase();
  const preCopies = preInstallCopyLines(input.preInstallCopyPaths);
  const openssl = alpineOpensslLines(input.needsOpenssl || input.preInstallCopyPaths?.includes('prisma'));

  if (framework === 'VITE') {
    // Multi-stage on node:20-alpine only — no nginx base pull (registry-independent builder).
    const port = input.port && input.port > 0 && input.port !== 4173 ? input.port : 80;
    const buildArgKeys = (input.buildArgKeys ?? []).filter((key) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
    );
    // Public build-time only (NEXT_PUBLIC_* / VITE_*). Injected before npm run build.
    const builderArgLines = buildArgKeys.flatMap((key) => [`ARG ${key}`, `ENV ${key}=$${key}`]);
    return {
      dockerfile: [
        'FROM node:20-alpine AS builder',
        'WORKDIR /app',
        ...openssl,
        'COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./',
        ...preCopies,
        'RUN npm config set registry https://registry.npmmirror.com',
        installInstruction(input.packageManager),
        'COPY . .',
        ...builderArgLines,
        'RUN npm run build',
        'FROM node:20-alpine',
        'WORKDIR /app',
        'RUN npm config set registry https://registry.npmmirror.com && npm install -g serve@14',
        'COPY --from=builder /app/dist ./dist',
        'ENV NODE_ENV=production',
        `ENV PORT=${port}`,
        'ENV HOSTNAME=0.0.0.0',
        `EXPOSE ${port}`,
        `CMD ["serve","-s","dist","-l","${port}"]`,
        '',
      ].join('\n'),
      dockerignore: `${DOCKERIGNORE}.env\n.env.*\n!.env.example\n`,
      extraFiles: {},
      containerPort: port,
      runtime: 'vite',
    };
  }

  if (framework !== 'NEXTJS' && framework !== 'NODE' && framework !== 'NESTJS') {
    throw new Error(`当前阶段 Docker Runtime 不支持 ${framework}`);
  }

  const port = input.port && input.port > 0 ? input.port : 3000;
  const buildArgKeys = (input.buildArgKeys ?? []).filter((key) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
  );
  const argLines = buildArgKeys.flatMap((key) => [`ARG ${key}`, `ENV ${key}=$${key}`]);

  const dockerfile = [
    'FROM node:20-alpine',
    'WORKDIR /app',
    ...openssl,
    'COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./',
    ...preCopies,
    'RUN npm config set registry https://registry.npmmirror.com',
    installInstruction(input.packageManager),
    'COPY . .',
    ...argLines,
    framework === 'NEXTJS' ? 'RUN npm run build' : null,
    'ENV NODE_ENV=production',
    `ENV PORT=${port}`,
    'ENV HOSTNAME=0.0.0.0',
    `EXPOSE ${port}`,
    cmdInstruction(input.startCommand),
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    dockerfile,
    dockerignore:
      framework === 'NEXTJS'
        ? `${DOCKERIGNORE}.next\n.env\n.env.*\n!.env.example\n`
        : `${DOCKERIGNORE}.env\n.env.*\n!.env.example\n`,
    extraFiles: {},
    containerPort: port,
    runtime: framework === 'NEXTJS' ? 'nextjs' : 'nodejs',
  };
}

function installInstruction(manager?: string | null): string {
  if (manager === 'pnpm') {
    return 'RUN npm install -g pnpm && pnpm install --frozen-lockfile';
  }
  if (manager === 'yarn') {
    return 'RUN yarn install --frozen-lockfile';
  }
  // Prefer full install (including devDependencies) — NODE_ENV=production is set AFTER install/build.
  return 'RUN npm install';
}

function cmdInstruction(startCommand?: string | null): string {
  const raw = (startCommand ?? '').trim();
  if (!raw) {
    throw new Error('ARTIFACT_NOT_RUNNABLE: missing resolved start command');
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  return `CMD ${JSON.stringify(parts)}`;
}
