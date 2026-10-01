import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, normalize, relative, resolve, sep } from 'node:path';
import type {
  AnalyzedDeployableUnit,
  AnalyzedFramework,
  AnalyzedPackageManager,
  DeployableCandidate,
  DeployableUnitType,
  ProjectAnalysisResult,
} from './types';

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  'vendor',
  'pods',
  'deriveddata',
  'tmp',
  'temp',
  '.cache',
  '.turbo',
  '.expo',
]);

const MAX_DEPTH = 4;
const MAX_DIRS = 400;

const UNSUPPORTED: ProjectAnalysisResult = {
  projectType: 'UNSUPPORTED',
  framework: 'UNSUPPORTED',
  packageManager: null,
  installCommand: null,
  buildCommand: null,
  startCommand: null,
  port: null,
  confidence: 0,
  units: [],
  candidates: [],
  primaryUnitPath: null,
};

export class ProjectAnalyzer {
  async analyzeRepository(path: string): Promise<ProjectAnalysisResult> {
    const units = await this.scanDeployableUnits(path);
    if (units.length === 0) {
      return UNSUPPORTED;
    }

    const primary =
      units.find((u) => u.rootPath === '.') ||
      units.find((u) => u.deployable) ||
      units[0]!;

    return {
      projectType: toLegacyProjectType(primary),
      framework: primary.framework,
      packageManager: primary.packageManager,
      installCommand: primary.installCommand,
      buildCommand: primary.buildCommand,
      startCommand: primary.startCommand,
      port: primary.port,
      confidence: primary.confidence,
      units,
      candidates: units.map(toLegacyCandidate),
      primaryUnitPath: primary.rootPath,
      summary:
        units.length === 1
          ? primary.reason
          : `发现 ${units.length} 个可上线内容，请选择要上线的部分。`,
    };
  }

  async scanDeployableUnits(repoRoot: string): Promise<AnalyzedDeployableUnit[]> {
    const root = resolve(repoRoot);
    const packageDirs = await collectPackageDirs(root);
    const units: AnalyzedDeployableUnit[] = [];
    const claimed = new Set<string>();

    // Prefer nested app dirs over monorepo root when workspaces exist.
    const monorepo = await isMonorepoRoot(root);
    const ordered = [...packageDirs].sort((a, b) => {
      const da = a === root ? 0 : a.split(sep).length;
      const db = b === root ? 0 : b.split(sep).length;
      // Deeper first so apps/web claims before root.
      return db - da || a.localeCompare(b);
    });

    for (const dir of ordered) {
      const rel = toRootPath(root, dir);
      if (claimed.has(rel)) {
        continue;
      }
      if (monorepo && rel === '.' && packageDirs.some((d) => d !== root)) {
        // Skip bare workspace root unless it is itself an Expo/RN or concrete web app.
        const rootPkg = await readPackageJson(join(dir, 'package.json'));
        const isMobileRoot =
          rootPkg && (hasDependency(rootPkg, 'expo') || hasDependency(rootPkg, 'react-native'));
        const isConcreteWeb =
          rootPkg &&
          (hasDependency(rootPkg, 'next') ||
            hasDependency(rootPkg, 'vite') ||
            hasDependency(rootPkg, '@nestjs/core'));
        if (!isMobileRoot && !isConcreteWeb) {
          continue;
        }
      }

      const unit = await analyzeDirectory(root, dir);
      if (!unit) {
        continue;
      }
      // Skip if a parent already claimed a broader mobile/native unit covering this.
      if ([...claimed].some((c) => c !== unit.rootPath && isPathPrefix(c, unit.rootPath))) {
        continue;
      }
      units.push(unit);
      claimed.add(unit.rootPath);
    }

    // Native iOS / Android / mini program dirs without package.json
    const nativeUnits = await scanNativeUnits(root, claimed);
    units.push(...nativeUnits);

    return dedupeUnits(units);
  }
}

async function analyzeDirectory(
  repoRoot: string,
  dir: string,
): Promise<AnalyzedDeployableUnit | null> {
  const rootPath = toRootPath(repoRoot, dir);
  const pkg = await readPackageJson(join(dir, 'package.json'));

  const mini = await detectMiniProgram(dir, rootPath);
  if (mini) {
    return mini;
  }

  if (pkg) {
    const expoish = detectExpoOrReactNative(pkg, dir);
    if (expoish) {
      return {
        name: displayName(rootPath, pkg.name, expoish === 'EXPO' ? 'Expo APP' : 'React Native APP'),
        type: 'MOBILE_CROSS_PLATFORM',
        rootPath,
        framework: expoish,
        packageManager: detectPackageManager(dir),
        installCommand: null,
        buildCommand: null,
        startCommand: null,
        outputPath: null,
        port: null,
        deployable: false,
        confidence: 0.95,
        reason: '当前版本暂不支持直接发布移动 APP。',
      };
    }

    const framework = detectWebFramework(pkg);
    if (framework !== 'UNSUPPORTED') {
      const type = inferWebType(rootPath, framework, pkg);
      const packageManager = detectPackageManager(dir);
      const deployable = isWebDeployableFramework(framework);
      return {
        name: displayName(rootPath, pkg.name, labelForType(type, framework)),
        type,
        rootPath,
        framework,
        packageManager,
        installCommand: installCommandFor(packageManager),
        buildCommand: buildCommandFor(packageManager, pkg, framework),
        startCommand: startCommandFor(packageManager, pkg, framework),
        outputPath: outputPathFor(framework),
        port: detectPort(pkg, framework),
        deployable,
        confidence: confidenceFor(framework),
        reason: deployable ? '可以上线。' : '当前版本暂不支持上线这一部分。',
      };
    }
  }

  const ios = detectNativeIosSignals(dir);
  if (ios.score >= 2) {
    return {
      name: displayName(rootPath, undefined, 'iOS APP'),
      type: 'IOS',
      rootPath,
      framework: 'IOS_NATIVE',
      packageManager: null,
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputPath: null,
      port: null,
      deployable: false,
      confidence: Math.min(0.98, 0.55 + ios.score * 0.1),
      reason: '当前版本暂不支持直接发布 iOS APP。',
    };
  }

  const android = detectAndroidSignals(dir);
  if (android) {
    return {
      name: displayName(rootPath, undefined, 'Android APP'),
      type: 'ANDROID',
      rootPath,
      framework: 'ANDROID',
      packageManager: null,
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputPath: null,
      port: null,
      deployable: false,
      confidence: 0.9,
      reason: '当前版本暂不支持直接发布 Android APP。',
    };
  }

  return null;
}

async function scanNativeUnits(
  repoRoot: string,
  claimed: Set<string>,
): Promise<AnalyzedDeployableUnit[]> {
  const units: AnalyzedDeployableUnit[] = [];
  const dirs = listDirsLimited(repoRoot, MAX_DEPTH);
  for (const dir of dirs) {
    const rel = toRootPath(repoRoot, dir);
    if (claimed.has(rel) || [...claimed].some((c) => isPathPrefix(c, rel))) {
      continue;
    }
    if (existsSync(join(dir, 'package.json'))) {
      continue;
    }
    const unit = await analyzeDirectory(repoRoot, dir);
    if (unit && (unit.type === 'IOS' || unit.type === 'ANDROID' || unit.type === 'MINI_PROGRAM')) {
      units.push(unit);
      claimed.add(unit.rootPath);
    }
  }
  return units;
}

async function detectMiniProgram(
  dir: string,
  rootPath: string,
): Promise<AnalyzedDeployableUnit | null> {
  const hasProjectConfig = existsSync(join(dir, 'project.config.json'));
  const hasAppJson = existsSync(join(dir, 'app.json'));
  const hasAppJs = existsSync(join(dir, 'app.js')) || existsSync(join(dir, 'app.ts'));
  const hasPages = existsSync(join(dir, 'pages'));
  if (!(hasProjectConfig || (hasAppJson && hasAppJs && hasPages))) {
    return null;
  }
  // Avoid treating Expo app.json as mini program.
  if (existsSync(join(dir, 'package.json'))) {
    const pkg = await readPackageJson(join(dir, 'package.json'));
    if (pkg && (hasDependency(pkg, 'expo') || hasDependency(pkg, 'react-native') || hasDependency(pkg, 'next'))) {
      return null;
    }
  }
  if (!hasProjectConfig && !(hasAppJs && hasPages)) {
    return null;
  }
  return {
    name: displayName(rootPath, undefined, '微信小程序'),
    type: 'MINI_PROGRAM',
    rootPath,
    framework: 'WECHAT_MINIPROGRAM',
    packageManager: null,
    installCommand: null,
    buildCommand: null,
    startCommand: null,
    outputPath: null,
    port: null,
    deployable: false,
    confidence: hasProjectConfig ? 0.92 : 0.8,
    reason: '当前版本暂不支持直接发布微信小程序。',
  };
}

function detectAndroidSignals(dir: string): boolean {
  return (
    existsSync(join(dir, 'AndroidManifest.xml')) ||
    existsSync(join(dir, 'build.gradle')) ||
    existsSync(join(dir, 'settings.gradle')) ||
    existsSync(join(dir, 'app', 'src', 'main', 'AndroidManifest.xml'))
  );
}

function detectNativeIosSignals(repoPath: string): { score: number } {
  let score = 0;
  let swiftFiles = 0;
  const stack = [{ dir: repoPath, depth: 0 }];
  let seen = 0;
  while (stack.length && seen < 3000) {
    const { dir, depth } = stack.pop()!;
    if (depth > 3) {
      continue;
    }
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name.toLowerCase()) || name === 'node_modules') {
        continue;
      }
      const full = join(dir, name);
      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        if (name.endsWith('.xcodeproj')) {
          score += 2;
        }
        if (name.endsWith('.xcworkspace')) {
          score += 2;
        }
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      seen += 1;
      const lower = name.toLowerCase();
      if (lower === 'podfile') {
        score += 2;
      }
      if (lower === 'package.swift') {
        score += 2;
      }
      if (lower === 'info.plist') {
        score += 1;
      }
      if (lower.endsWith('.swift')) {
        swiftFiles += 1;
      }
    }
  }
  if (swiftFiles >= 5) {
    score += 2;
  } else if (swiftFiles >= 1) {
    score += 1;
  }
  return { score };
}

function detectExpoOrReactNative(pkg: PackageJson, repoPath: string): 'EXPO' | 'REACT_NATIVE' | null {
  const hasExpo = hasDependency(pkg, 'expo');
  const hasRn = hasDependency(pkg, 'react-native');
  const scripts = Object.values(pkg.scripts ?? {}).join(' ').toLowerCase();
  const expoScript = /\bexpo\b/.test(scripts);
  const appJson =
    existsSync(join(repoPath, 'app.json')) ||
    existsSync(join(repoPath, 'app.config.js')) ||
    existsSync(join(repoPath, 'app.config.ts'));
  const easJson = existsSync(join(repoPath, 'eas.json'));
  if (hasExpo || (appJson && expoScript) || (easJson && (hasExpo || hasRn))) {
    return 'EXPO';
  }
  if (hasRn) {
    return 'REACT_NATIVE';
  }
  return null;
}

function detectWebFramework(pkg: PackageJson): AnalyzedFramework {
  if (hasDependency(pkg, 'expo') || hasDependency(pkg, 'react-native')) {
    return 'UNSUPPORTED';
  }
  if (hasDependency(pkg, '@nestjs/core') || hasDependency(pkg, '@nestjs/common')) {
    return 'NESTJS';
  }
  if (hasDependency(pkg, 'next')) {
    return 'NEXTJS';
  }
  if (hasDependency(pkg, 'vite')) {
    return 'VITE';
  }
  if (hasDependency(pkg, 'vue')) {
    return 'VUE';
  }
  if (
    hasDependency(pkg, 'express') ||
    hasDependency(pkg, 'fastify') ||
    hasDependency(pkg, 'koa') ||
    pkg.scripts?.start
  ) {
    if (pkg.scripts?.start && /\bexpo\b/i.test(pkg.scripts.start)) {
      return 'UNSUPPORTED';
    }
    return 'NODE';
  }
  return 'UNSUPPORTED';
}

function inferWebType(
  rootPath: string,
  framework: AnalyzedFramework,
  pkg: PackageJson,
): DeployableUnitType {
  const base = rootPath === '.' ? '' : rootPath.toLowerCase();
  const name = (pkg.name || '').toLowerCase();
  if (/(^|\/)admin(\/|$)/.test(base) || /(^|\/)dashboard(\/|$)/.test(base) || /(^|\/)cms(\/|$)/.test(base) || name.includes('admin')) {
    if (framework === 'NEXTJS' || framework === 'VITE' || framework === 'VUE' || framework === 'NODE') {
      return 'ADMIN';
    }
  }
  if (
    framework === 'NESTJS' ||
    hasDependency(pkg, 'express') ||
    hasDependency(pkg, 'fastify') ||
    /(^|\/)api(\/|$)/.test(base) ||
    /(^|\/)server(\/|$)/.test(base) ||
    name.endsWith('-api') ||
    name.includes('api')
  ) {
    if (framework === 'NESTJS' || hasDependency(pkg, 'express') || hasDependency(pkg, 'fastify') || /(^|\/)api(\/|$)/.test(base)) {
      return 'API';
    }
  }
  return 'WEB';
}

async function collectPackageDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  if (existsSync(join(root, 'package.json'))) {
    found.push(root);
  }
  const dirs = listDirsLimited(root, MAX_DEPTH);
  for (const dir of dirs) {
    if (existsSync(join(dir, 'package.json'))) {
      found.push(dir);
    }
  }
  return found;
}

function listDirsLimited(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < MAX_DIRS) {
    const { dir, depth } = stack.pop()!;
    if (depth >= maxDepth) {
      continue;
    }
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name.toLowerCase()) || name.startsWith('.')) {
        // allow . but skip known; still skip .git etc via SKIP
        if (name !== '.' && name.startsWith('.') && name !== '..') {
          continue;
        }
      }
      if (SKIP_DIRS.has(name.toLowerCase())) {
        continue;
      }
      const full = join(dir, name);
      try {
        if (!statSync(full).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      out.push(full);
      stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return out;
}

async function isMonorepoRoot(root: string): Promise<boolean> {
  if (
    existsSync(join(root, 'pnpm-workspace.yaml')) ||
    existsSync(join(root, 'turbo.json')) ||
    existsSync(join(root, 'nx.json')) ||
    existsSync(join(root, 'lerna.json'))
  ) {
    return true;
  }
  const pkg = await readPackageJson(join(root, 'package.json'));
  if (!pkg?.workspaces) {
    return false;
  }
  return true;
}

function dedupeUnits(units: AnalyzedDeployableUnit[]): AnalyzedDeployableUnit[] {
  const byPath = new Map<string, AnalyzedDeployableUnit>();
  for (const unit of units) {
    const existing = byPath.get(unit.rootPath);
    if (!existing || unit.confidence > existing.confidence) {
      byPath.set(unit.rootPath, unit);
    }
  }
  return [...byPath.values()].sort((a, b) => a.rootPath.localeCompare(b.rootPath));
}

function toRootPath(repoRoot: string, dir: string): string {
  const rel = relative(resolve(repoRoot), resolve(dir)).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

export function resolveUnitPath(repositoryRoot: string, rootPath: string): string {
  const root = resolve(repositoryRoot);
  const cleaned = normalize(rootPath || '.').replace(/^(\.\/)+/, '');
  if (cleaned.includes('\0') || cleaned.startsWith('..') || cleaned.split(/[/\\]/).includes('..')) {
    throw new Error('非法 rootPath');
  }
  if (cleaned === '.' || cleaned === '') {
    return root;
  }
  const full = resolve(root, cleaned);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(prefix)) {
    throw new Error('rootPath 必须位于仓库目录内');
  }
  return full;
}

export function isWebDeployableFramework(framework: string | null | undefined): boolean {
  const value = framework?.toUpperCase();
  return value === 'NEXTJS' || value === 'VITE' || value === 'VUE' || value === 'NODE' || value === 'NESTJS';
}

export function isMobileFramework(framework: string | null | undefined): boolean {
  const value = framework?.toUpperCase();
  return (
    value === 'IOS_NATIVE' ||
    value === 'EXPO' ||
    value === 'REACT_NATIVE' ||
    value === 'WECHAT_MINIPROGRAM' ||
    value === 'ANDROID'
  );
}

export function isDeployableUnitType(type: string | null | undefined): boolean {
  return type === 'WEB' || type === 'API' || type === 'ADMIN';
}

function toLegacyProjectType(unit: AnalyzedDeployableUnit): ProjectAnalysisResult['projectType'] {
  if (unit.type === 'IOS' || unit.type === 'MOBILE_CROSS_PLATFORM') {
    return 'IOS_NATIVE';
  }
  if (unit.deployable) {
    return 'WEB';
  }
  return 'UNSUPPORTED';
}

function toLegacyCandidate(unit: AnalyzedDeployableUnit): DeployableCandidate {
  let kind: DeployableCandidate['kind'] = 'UNSUPPORTED';
  if (unit.framework === 'EXPO') {
    kind = 'EXPO';
  } else if (unit.framework === 'REACT_NATIVE') {
    kind = 'REACT_NATIVE';
  } else if (unit.type === 'IOS' || unit.framework === 'IOS_NATIVE') {
    kind = 'IOS_NATIVE';
  } else if (unit.deployable) {
    kind = 'WEB';
  }
  return {
    path: unit.rootPath,
    kind,
    label: unit.name,
    deployable: unit.deployable,
    reason: unit.reason,
  };
}

function displayName(rootPath: string, pkgName: string | null | undefined, fallback: string): string {
  if (rootPath !== '.' && rootPath.length > 0) {
    const leaf = rootPath.split('/').filter(Boolean).at(-1);
    if (leaf) {
      return leaf;
    }
  }
  return pkgName || fallback;
}

function labelForType(type: DeployableUnitType, framework: AnalyzedFramework): string {
  if (type === 'ADMIN') {
    return '管理后台';
  }
  if (type === 'API') {
    return 'API 服务';
  }
  if (framework === 'NEXTJS') {
    return 'Next.js 网站';
  }
  if (framework === 'VITE') {
    return 'Vite 网站';
  }
  return '网站';
}

function hasDependency(pkg: PackageJson, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

function detectPackageManager(repoPath: string): AnalyzedPackageManager {
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(repoPath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(join(repoPath, 'bun.lock')) || existsSync(join(repoPath, 'bun.lockb'))) {
    return 'bun';
  }
  return 'npm';
}

export function installCommandFor(manager: AnalyzedPackageManager): string {
  if (manager === 'pnpm') {
    return 'pnpm install';
  }
  if (manager === 'yarn') {
    return 'yarn install';
  }
  if (manager === 'bun') {
    return 'bun install';
  }
  return 'npm install';
}

export function installCommandFromManager(manager: string | null | undefined): string | null {
  if (manager === 'npm' || manager === 'pnpm' || manager === 'yarn' || manager === 'bun') {
    return installCommandFor(manager);
  }
  return null;
}

function runScript(manager: AnalyzedPackageManager, script: string): string {
  if (manager === 'pnpm') {
    return `pnpm ${script === 'start' ? 'start' : `run ${script}`}`;
  }
  if (manager === 'yarn') {
    return script === 'start' ? 'yarn start' : `yarn ${script}`;
  }
  if (manager === 'bun') {
    return script === 'start' ? 'bun start' : `bun run ${script}`;
  }
  return script === 'start' ? 'npm start' : `npm run ${script}`;
}

function buildCommandFor(
  manager: AnalyzedPackageManager,
  pkg: PackageJson,
  framework: AnalyzedFramework,
): string | null {
  if (framework === 'NEXTJS' || framework === 'VITE' || framework === 'NESTJS' || pkg.scripts?.build) {
    return runScript(manager, 'build');
  }
  return null;
}

function startCommandFor(
  manager: AnalyzedPackageManager,
  pkg: PackageJson,
  framework: AnalyzedFramework,
): string | null {
  if (framework === 'NESTJS' && pkg.scripts?.['start:prod']) {
    return runScript(manager, 'start:prod');
  }
  if (pkg.scripts?.start || framework === 'NEXTJS' || framework === 'NODE' || framework === 'NESTJS') {
    return runScript(manager, 'start');
  }
  if (framework === 'VITE' && pkg.scripts?.preview) {
    return runScript(manager, 'preview');
  }
  return null;
}

function outputPathFor(framework: AnalyzedFramework): string | null {
  if (framework === 'VITE' || framework === 'VUE') {
    return 'dist';
  }
  if (framework === 'NEXTJS') {
    return '.next';
  }
  return null;
}

function detectPort(pkg: PackageJson, framework: AnalyzedFramework): number {
  const blob = Object.values(pkg.scripts ?? {}).join(' ');
  const matched = blob.match(/(?:--port|-p|PORT=)\s*(\d{2,5})/i);
  if (matched?.[1]) {
    return Number(matched[1]);
  }
  if (framework === 'NEXTJS' || framework === 'NESTJS') {
    return 3000;
  }
  return 3000;
}

function confidenceFor(framework: AnalyzedFramework): number {
  if (framework === 'NEXTJS' || framework === 'NESTJS') {
    return 0.95;
  }
  if (framework === 'VITE') {
    return 0.9;
  }
  if (framework === 'VUE') {
    return 0.85;
  }
  if (framework === 'NODE') {
    return 0.7;
  }
  return 0;
}

async function readPackageJson(filePath: string): Promise<PackageJson | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function isPathPrefix(parentRel: string, childRel: string): boolean {
  if (parentRel === '.') {
    return childRel !== '.';
  }
  return childRel === parentRel || childRel.startsWith(parentRel + '/');
}
