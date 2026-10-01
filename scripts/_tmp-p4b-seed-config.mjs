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
const { encryptCredential } = requireApi('@launchos/shared');
const prisma = new PrismaClient();

const TEST_PROJECT = 'cmucerx5e0001ri4w0x6sx5cz';
const TEST_UNIT = 'cmucerx680006ri4w0qcdtp8c';

const reqs = await prisma.runtimeConfigRequirement.findMany({
  where: { deployableUnitId: TEST_UNIT },
});

for (const req of reqs) {
  const value =
    req.key === 'NEXT_PUBLIC_API_URL'
      ? 'https://api-launchos.zsaos.com'
      : req.key === 'SENTRY_DSN'
        ? 'https://example@sentry.invalid/0'
        : '';
  if (!value) continue;
  await prisma.runtimeConfigValue.upsert({
    where: {
      scopeType_scopeId_key: {
        scopeType: 'UNIT',
        scopeId: TEST_UNIT,
        key: req.key,
      },
    },
    create: {
      projectId: TEST_PROJECT,
      scopeType: 'UNIT',
      scopeId: TEST_UNIT,
      deployableUnitId: TEST_UNIT,
      requirementId: req.id,
      scope: 'UNIT',
      key: req.key,
      valueEncrypted: encryptCredential(value),
      isSensitive: req.sensitive,
      source: 'MANUAL',
    },
    update: {
      valueEncrypted: encryptCredential(value),
      requirementId: req.id,
      isSensitive: req.sensitive,
    },
  });
  // Soften SENTRY required if needed for Vite static
  if (req.key === 'SENTRY_DSN') {
    await prisma.runtimeConfigRequirement.update({
      where: { id: req.id },
      data: { required: false },
    });
  }
  console.log('set', req.key);
}

await prisma.$disconnect();
