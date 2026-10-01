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

const values = await p.runtimeConfigValue.findMany({
  where: {
    projectId: PROJECT,
    key: { in: ['NEXT_PUBLIC_API_URL', 'SENTRY_DSN'] },
  },
  select: {
    key: true,
    scopeType: true,
    scopeId: true,
    deployableUnitId: true,
    isSensitive: true,
    valueEncrypted: true,
    valuePlaintext: true,
  },
});

console.log(
  JSON.stringify(
    values.map((v) => ({
      key: v.key,
      scopeType: v.scopeType,
      scopeId: v.scopeId,
      deployableUnitId: v.deployableUnitId,
      isSensitive: v.isSensitive,
      hasEncrypted: Boolean(v.valueEncrypted),
      plaintextPresent: Boolean(v.valuePlaintext),
      plaintextPreview:
        v.valuePlaintext && !v.isSensitive
          ? String(v.valuePlaintext).slice(0, 80)
          : v.valuePlaintext
            ? 'present=true'
            : null,
    })),
    null,
    2,
  ),
);
await p.$disconnect();
