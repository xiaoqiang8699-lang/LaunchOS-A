/**
 * Restore placement-compatible resolvedSku for Step 25.4 CR.
 * No CreateInstance / enqueue / confirm-billing.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
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

const CR = process.argv[2] || 'cmu4xn1j60001riaw6gjh0rfn';
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const prisma = new PrismaClient();
const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
if (!cr) {
  console.error('not found');
  process.exit(1);
}
const meta = cr.metadata && typeof cr.metadata === 'object' ? cr.metadata : {};
const placementZoneId = meta.placementZoneId || 'cn-hangzhou-i';
const resolvedSku = {
  tier: 'DEV',
  instanceClass: 'redis.master.small.default',
  engineVersion: '5.0',
  storageType: 'Local',
  capacityMb: 1024,
  zoneId: placementZoneId,
  architecture: 'standard',
  selectionReason:
    'storage=Local, class=redis.master.small.default, version=5.0, capacityMb=1024',
  availabilityFingerprint: `cn-hangzhou|Local|redis.master.small.default|5.0|1024|${placementZoneId}`,
};

await prisma.cloudResource.update({
  where: { id: CR },
  data: {
    metadata: {
      ...meta,
      ...resolvedSku,
      resolvedSku,
      placementZoneId,
      skuAdaptedForPlacementZone: true,
      previousResolvedSku: meta.resolvedSku || meta.previousResolvedSku || null,
    },
  },
});

const after = await prisma.cloudResource.findUnique({ where: { id: CR } });
console.log(
  JSON.stringify(
    {
      restored: true,
      cloudResourceId: CR,
      resolvedSku: after.metadata.resolvedSku,
      placementZoneId: after.metadata.placementZoneId,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
