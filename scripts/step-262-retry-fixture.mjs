/**
 * Non-billing fixture: proves FAILED → archive → QUEUED → PREPARING_* phase
 * progression can be recorded without RunInstances / --confirm-billing.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../packages/database/generated/client/index.js');
const {
  archiveServerProvisionCurrentFailure,
} = require('../packages/shared/dist/server-provision.js');
const { serverProvisionJobId } = require('../packages/shared/dist/queue.js');

const id = 'cmuas8iiz0001riown1l1a0o3';
const p = new PrismaClient();
const r = await p.cloudResource.findUnique({ where: { id } });
if (!r) {
  console.error('NOT_FOUND');
  process.exit(1);
}
const meta = r.metadata && typeof r.metadata === 'object' ? { ...r.metadata } : {};
const gen = Math.max(1, Number(meta.createGeneration || 2));
const archived = archiveServerProvisionCurrentFailure(meta);
const now = new Date().toISOString();
const phases = [
  ...(Array.isArray(archived.phases) ? archived.phases : []),
  { phase: 'QUEUED', at: now, status: 'running', resume: true },
  { phase: 'RECONCILING', at: now, status: 'running', fixture: true },
  { phase: 'PREPARING_NETWORK', at: now, status: 'running', fixture: true },
  { phase: 'PREPARING_SECURITY_GROUP', at: now, status: 'running', fixture: true },
];

await p.cloudResource.update({
  where: { id },
  data: {
    status: 'CREATING',
    metadata: {
      ...archived,
      createGeneration: gen,
      phase: 'PREPARING_SECURITY_GROUP',
      phases,
      fixturePhaseAdvance: true,
      fixtureNote: 'non-billing phase fixture; RunInstances not called',
    },
  },
});

const after = await p.cloudResource.findUnique({ where: { id } });
const m = after.metadata;
const reached = (m.phases || []).map((x) => x.phase);
console.log(
  JSON.stringify(
    {
      ok: true,
      cloudResourceId: id,
      status: after.status,
      phase: m.phase,
      createGeneration: m.createGeneration,
      currentErrorCleared: m.currentErrorCleared === true,
      failedAt: m.failedAt,
      failedOperation: m.failedOperation,
      errorHistoryCount: Array.isArray(m.errorHistory) ? m.errorHistory.length : 0,
      phasesReached: reached,
      expectedJobId: serverProvisionJobId(id, gen),
      runInstancesAttemptCount: m.runInstancesAttemptCount || 0,
      advancedToPreparingSecurityGroup: reached.includes('PREPARING_SECURITY_GROUP'),
    },
    null,
    2,
  ),
);

// Restore FAILED shell for safe resume later (keep archived history + cleared current errors)
await p.cloudResource.update({
  where: { id },
  data: {
    status: 'FAILED',
    metadata: {
      ...m,
      phase: 'FAILED',
      failedPhase: 'PREPARING_SECURITY_GROUP',
      // keep current errors null — resume must clear; lastFailure retained
      fixturePhaseAdvance: false,
    },
  },
});
console.log('restored FAILED shell for safe resume; generation=', gen);
await p.$disconnect();
