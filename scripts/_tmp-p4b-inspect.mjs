import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const p = new PrismaClient();

const a = await p.projectAnalysis.findFirst({
  where: { projectId: 'cmu3j24mv0001ri7wcsoa30hj' },
  orderBy: { createdAt: 'desc' },
  select: { repositoryPath: true, framework: true },
});
const t = await p.project.findUnique({
  where: { id: 'cmucerx5e0001ri4w0x6sx5cz' },
  include: { deployableUnits: true, sources: true, environments: true },
});
const ta = await p.projectAnalysis.findFirst({
  where: { projectId: 'cmucerx5e0001ri4w0x6sx5cz' },
});
console.log(
  JSON.stringify(
    {
      demoAnalysis: a,
      demoPathExists: a?.repositoryPath ? existsSync(a.repositoryPath) : false,
      testProject: t && {
        id: t.id,
        units: t.deployableUnits.map((u) => ({ id: u.id, type: u.type, rootPath: u.rootPath })),
        sources: t.sources,
        envs: t.environments,
      },
      testAnalysis: ta,
    },
    null,
    2,
  ),
);
await p.$disconnect();
