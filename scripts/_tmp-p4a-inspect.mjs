import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
const prisma = new PrismaClient();

const demo = await prisma.project.findUnique({
  where: { id: 'cmu3j24mv0001ri7wcsoa30hj' },
  include: {
    deployableUnits: true,
    sources: true,
    gatewayRoutes: true,
    environments: true,
  },
});

const existing = await prisma.project.findMany({
  where: {
    OR: [{ slug: { contains: 'oneclick' } }, { name: { contains: 'ONE_CLICK' } }],
  },
  select: { id: true, slug: true, name: true },
});

const web = demo?.deployableUnits.find((u) => u.type === 'WEB');
console.log(
  JSON.stringify(
    {
      workspaceId: demo?.workspaceId,
      env: demo?.environments,
      web,
      sources: demo?.sources,
      existing,
      gatewayHostnames: demo?.gatewayRoutes.map((g) => g.hostname),
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
