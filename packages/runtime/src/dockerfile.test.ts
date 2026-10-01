import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDockerFiles, resolvePreInstallCopyPaths } from './dockerfile.js';

test('Next.js Dockerfile copies prisma before npm install when requested', () => {
  const files = generateDockerFiles({
    framework: 'NEXTJS',
    packageManager: 'npm',
    startCommand: 'npm run start',
    port: 3000,
    preInstallCopyPaths: resolvePreInstallCopyPaths({ hasPrismaSchema: true }),
    needsOpenssl: true,
  });
  const idxPrisma = files.dockerfile.indexOf('COPY prisma ./prisma');
  const idxInstall = files.dockerfile.indexOf('RUN npm install');
  const idxCopyAll = files.dockerfile.indexOf('COPY . .');
  assert.ok(idxPrisma > 0);
  assert.ok(idxInstall > idxPrisma);
  assert.ok(idxCopyAll > idxInstall);
  assert.match(files.dockerfile, /apk add --no-cache libc6-compat openssl/);
  assert.match(files.dockerfile, /FROM node:20-alpine/);
  assert.doesNotMatch(files.dockerfile, /npm ci/);
});

test('without prisma, install still runs after package.json copy only', () => {
  const files = generateDockerFiles({
    framework: 'NEXTJS',
    packageManager: 'npm',
    startCommand: 'npm run start',
  });
  assert.doesNotMatch(files.dockerfile, /COPY prisma/);
  assert.match(files.dockerfile, /COPY package\.json package-lock\.json\* yarn\.lock\* pnpm-lock\.yaml\* \.\//);
});

test('pnpm uses frozen lockfile install', () => {
  const files = generateDockerFiles({
    framework: 'NODE',
    packageManager: 'pnpm',
    startCommand: 'node dist/main.js',
  });
  assert.match(files.dockerfile, /pnpm install --frozen-lockfile/);
});
