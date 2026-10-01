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

const PROD_WEB = 'cmu3j27340007ri4w0qcdtp8c'; // wrong - use correct
const TEST_PROJECT = 'cmucerx5e0001ri4w0x6sx5cz';
const TEST_UNIT = 'cmucerx680006ri4w0qcdtp8c';
const PROD_UNIT = 'cmu3j27340007ri7wcno1xrai';

const prodReqs = await prisma.runtimeConfigRequirement.findMany({
  where: { deployableUnitId: PROD_UNIT },
  include: { values: true },
});
console.log(
  JSON.stringify(
    prodReqs.map((r) => ({
      key: r.key,
      required: r.required,
      sensitive: r.sensitive,
      values: r.values.map((v) => ({
        scopeType: v.scopeType,
        hasValue: Boolean(v.valueEncrypted || v.value),
      })),
    })),
    null,
    2,
  ),
);

const testReqs = await prisma.runtimeConfigRequirement.findMany({
  where: { deployableUnitId: TEST_UNIT },
});
console.log('testReqs', testReqs.length, testReqs.map((r) => r.key));

await prisma.$disconnect();
