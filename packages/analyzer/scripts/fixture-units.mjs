import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectAnalyzer, resolveUnitPath } from '../dist/index.js';

function write(dir, file, content) {
  const full = join(dir, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

async function main() {
  const root = join(tmpdir(), `launchos-du-fixtures-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const analyzer = new ProjectAnalyzer();
  const results = {};

  const nextDir = join(root, 'single-next');
  write(nextDir, 'package.json', JSON.stringify({ name: 'web', dependencies: { next: '15.0.0', react: '19.0.0' }, scripts: { build: 'next build', start: 'next start' } }));
  results.singleNext = await analyzer.analyzeRepository(nextDir);

  const expoDir = join(root, 'single-expo');
  write(expoDir, 'package.json', JSON.stringify({ name: 'app', dependencies: { expo: '~51.0.0', 'react-native': '0.74.0' }, scripts: { start: 'expo start' } }));
  write(expoDir, 'app.json', JSON.stringify({ expo: { name: 'app', slug: 'app' } }));
  results.singleExpo = await analyzer.analyzeRepository(expoDir);

  const mono = join(root, 'mono');
  write(mono, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
  write(mono, 'package.json', JSON.stringify({ name: 'root', private: true }));
  write(join(mono, 'apps/web'), 'package.json', JSON.stringify({ name: 'web', dependencies: { next: '15.0.0' }, scripts: { build: 'next build', start: 'next start' } }));
  write(join(mono, 'apps/api'), 'package.json', JSON.stringify({ name: 'api', dependencies: { '@nestjs/core': '10.0.0', '@nestjs/common': '10.0.0' }, scripts: { build: 'nest build', 'start:prod': 'node dist/main' } }));
  write(join(mono, 'apps/web/node_modules/fake'), 'x.js', '1');
  results.monorepo = await analyzer.analyzeRepository(mono);

  const mix = join(root, 'expo-privacy');
  write(mix, 'package.json', JSON.stringify({ name: 'mobile', dependencies: { expo: '~51.0.0', 'react-native': '0.74.0' }, scripts: { start: 'expo start' } }));
  write(mix, 'app.json', JSON.stringify({ expo: { name: 'm', slug: 'm' } }));
  write(join(mix, 'privacy-site'), 'package.json', JSON.stringify({ name: 'privacy', devDependencies: { vite: '6.0.0' }, scripts: { build: 'vite build', preview: 'vite preview' } }));
  results.expoPrivacy = await analyzer.analyzeRepository(mix);

  const mini = join(root, 'mini-api');
  write(join(mini, 'miniapp'), 'project.config.json', '{}');
  write(join(mini, 'miniapp'), 'app.js', '');
  mkdirSync(join(mini, 'miniapp/pages'), { recursive: true });
  write(join(mini, 'services/api'), 'package.json', JSON.stringify({ name: 'api', dependencies: { express: '4.0.0' }, scripts: { start: 'node index.js' } }));
  results.miniApi = await analyzer.analyzeRepository(mini);

  let traversalOk = false;
  try { resolveUnitPath(mix, '../outside'); } catch { traversalOk = true; }

  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  assert(results.singleNext.units.length === 1, 'single next units');
  assert(results.singleNext.units[0].framework === 'NEXTJS', 'next fw');
  assert(results.singleExpo.units[0].type === 'MOBILE_CROSS_PLATFORM', 'expo type');
  assert(results.singleExpo.units[0].deployable === false, 'expo not deployable');
  assert(results.monorepo.units.length === 2, 'mono 2 units');
  assert(!results.monorepo.units.some((u) => u.rootPath === '.'), 'mono no root');
  assert(results.expoPrivacy.units.length === 2, 'expo+privacy 2');
  assert(results.miniApi.units.length === 2, 'mini+api 2');
  assert(traversalOk, 'traversal rejected');

  console.log(JSON.stringify({
    ok: true,
    counts: {
      singleNext: results.singleNext.units.length,
      singleExpo: results.singleExpo.units.length,
      monorepo: results.monorepo.units.length,
      expoPrivacy: results.expoPrivacy.units.length,
      miniApi: results.miniApi.units.length,
    },
    monorepoUnits: results.monorepo.units.map((u) => ({ rootPath: u.rootPath, type: u.type, framework: u.framework, deployable: u.deployable })),
    expoPrivacyUnits: results.expoPrivacy.units.map((u) => ({ rootPath: u.rootPath, type: u.type, deployable: u.deployable })),
    miniApiUnits: results.miniApi.units.map((u) => ({ rootPath: u.rootPath, type: u.type, deployable: u.deployable })),
    traversalRejected: traversalOk,
  }, null, 2));
  rmSync(root, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
