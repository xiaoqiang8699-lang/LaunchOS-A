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
const { PrismaClient } = createRequire(resolve(root, 'apps/api/package.json'))('@launchos/database');
const p = new PrismaClient();
const r = await p.deployment.updateMany({
  where: {
    projectId: 'cmucerx5e0001ri4w0x6sx5cz',
    status: { in: ['CREATED', 'QUEUED', 'RUNNING'] },
  },
  data: { status: 'CANCELLED', finishedAt: new Date(), errorMessage: 'clear for p4b' },
});
console.log('cancelled', r.count);
await p.$disconnect();
