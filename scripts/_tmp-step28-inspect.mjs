import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const p = new PrismaClient();

const WEB = 'cmu3j27340007ri7wcno1xrai';
const API = 'cmu3j272x0005ri7wlxlbajeu';
const PROJECT = 'cmu3j24mv0001ri7wcsoa30hj';

const unit = await p.deployableUnit.findUnique({ where: { id: WEB } });
const api = await p.deployableUnit.findUnique({
  where: { id: API },
  select: {
    id: true,
    type: true,
    port: true,
    framework: true,
    startCommand: true,
    rootPath: true,
  },
});
const analysis = await p.projectAnalysis.findFirst({
  where: { projectId: PROJECT },
  orderBy: { createdAt: 'desc' },
  select: { repositoryPath: true, framework: true },
});
const arts = await p.artifact.findMany({
  where: { deployment: { projectId: PROJECT, deployableUnitId: WEB } },
  orderBy: { createdAt: 'desc' },
  take: 15,
  select: {
    id: true,
    type: true,
    status: true,
    size: true,
    checksum: true,
    metadata: true,
    deploymentId: true,
  },
});
const anyArts = await p.artifact.findMany({
  where: {
    deployment: { projectId: PROJECT },
    type: { in: ['BUILD_OUTPUT', 'DOCKER_IMAGE'] },
  },
  orderBy: { createdAt: 'desc' },
  take: 30,
  select: {
    id: true,
    type: true,
    status: true,
    size: true,
    metadata: true,
    deployment: { select: { deployableUnitId: true } },
  },
});
const configs = await p.runtimeConfigValue.findMany({
  where: {
    projectId: PROJECT,
    OR: [{ deployableUnitId: WEB }, { deployableUnitId: null }],
  },
  select: { key: true, deployableUnitId: true, isSensitive: true, provider: true },
});
let reqs = [];
try {
  reqs = await p.runtimeConfigRequirement.findMany({
    where: {
      projectId: PROJECT,
      OR: [{ deployableUnitId: WEB }, { deployableUnitId: null }],
    },
    select: { key: true, deployableUnitId: true, required: true, phase: true },
  });
} catch {
  reqs = [];
}
const apiSi = await p.serviceInstance.findUnique({
  where: { id: 'cmuc66642002hritk6h3cbwhe' },
  select: {
    id: true,
    status: true,
    healthStatus: true,
    externalPort: true,
    serverInstanceId: true,
  },
});

let pkg = null;
if (analysis?.repositoryPath && unit?.rootPath != null) {
  const unitPath = join(
    analysis.repositoryPath,
    unit.rootPath && unit.rootPath !== '.' ? unit.rootPath : '',
  );
  const pkgPath = join(unitPath, 'package.json');
  pkg = {
    unitPath,
    hasPackageJson: existsSync(pkgPath),
    scripts: existsSync(pkgPath)
      ? Object.keys(JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {})
      : [],
  };
}

console.log(
  JSON.stringify(
    {
      unit,
      api,
      analysis,
      arts,
      anyArts: anyArts.map((a) => ({
        id: a.id,
        type: a.type,
        status: a.status,
        size: a.size,
        unit: a.deployment?.deployableUnitId,
        metaKind: a.metadata?.kind,
        source: a.metadata?.sourceArtifactId,
      })),
      configs,
      reqs,
      apiSi,
      pkg,
    },
    null,
    2,
  ),
);
await p.$disconnect();
