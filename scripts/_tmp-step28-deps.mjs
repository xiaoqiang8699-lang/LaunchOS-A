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

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const p = new PrismaClient();
const WEB = 'cmu3j27340007ri7wcno1xrai';
const PROJECT = 'cmu3j24mv0001ri7wcsoa30hj';

const dbBind = await p.databaseConnectionUnit.findMany({
  where: { deployableUnitId: WEB },
  include: { databaseConnection: { select: { id: true, status: true } } },
});
const redisBind = await p.redisConnectionUnit.findMany({
  where: { deployableUnitId: WEB },
  include: { redisConnection: { select: { id: true, status: true } } },
});
const reqs = await p.runtimeConfigRequirement.findMany({
  where: { deployableUnitId: WEB },
  select: {
    key: true,
    required: true,
    injectionPhase: true,
    managedByLaunchOS: true,
    status: true,
  },
});
const apiReqs = await p.runtimeConfigRequirement.findMany({
  where: { deployableUnitId: 'cmu3j272x0005ri7wlxlbajeu' },
  select: { key: true, required: true, injectionPhase: true },
  take: 30,
});

console.log(JSON.stringify({ dbBind, redisBind, reqs, apiReqs }, null, 2));
await p.$disconnect();
