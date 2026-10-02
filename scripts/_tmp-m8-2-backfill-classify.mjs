/**
 * M8-2 subscription source backfill classification (dry-run by default).
 * Never promotes PAYMENT_TEST into PAYMENT subscriptions.
 * node scripts/_tmp-m8-2-backfill-classify.mjs [--apply]
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const apply = process.argv.includes('--apply');
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { classifySubscriptionForBackfill } = requireApi('@launchos/domain');

const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });
const prisma = new PrismaClient();

const testPaid = await prisma.payment.findMany({
  where: { isProductionTest: true, status: 'SUCCEEDED' },
  select: { id: true, workspaceId: true },
});
const testWs = new Set(testPaid.map((p) => p.workspaceId));

const rows = await prisma.subscription.findMany({
  include: { plan: true },
  orderBy: { createdAt: 'asc' },
});

const summary = { BACKFILL_USERS: rows.length, BACKFILL_FREE: 0, BACKFILL_BETA_OVERRIDE: 0, BACKFILL_PAYMENT_SUBSCRIPTIONS: 0, BACKFILL_AMBIGUOUS: 0 };
const ambiguous = [];
const updates = [];

for (const row of rows) {
  const hasOnlyTestPayment =
    testWs.has(row.workspaceId) &&
    !(await prisma.payment.count({
      where: { workspaceId: row.workspaceId, status: 'SUCCEEDED', isProductionTest: false },
    }));
  const classified = classifySubscriptionForBackfill({
    planCode: row.plan.code,
    source: row.source,
    status: row.status,
    complimentaryReason: row.complimentaryReason,
    overrideSource: row.overrideSource,
    latestPaymentId: row.latestPaymentId,
    isProductionTestPaymentOnly: hasOnlyTestPayment && row.plan.code === 'free',
  });
  if (classified.class === 'FREE') summary.BACKFILL_FREE += 1;
  if (classified.class === 'BETA_OVERRIDE') summary.BACKFILL_BETA_OVERRIDE += 1;
  if (classified.class === 'PAYMENT') summary.BACKFILL_PAYMENT_SUBSCRIPTIONS += 1;
  if (classified.class === 'AMBIGUOUS') {
    summary.BACKFILL_AMBIGUOUS += 1;
    ambiguous.push({ id: row.id, workspaceId: row.workspaceId, plan: row.plan.code, source: row.source, note: classified.note });
  }
  if (apply && classified.class !== 'AMBIGUOUS' && row.source !== classified.targetSource) {
    updates.push({ id: row.id, from: row.source, to: classified.targetSource });
    await prisma.subscription.update({
      where: { id: row.id },
      data: {
        source: classified.targetSource,
        billingCycle: row.plan.code === 'free' ? 'NONE' : row.billingCycle || 'NONE',
      },
    });
  }
}

const report = { apply, summary, ambiguous, updatesApplied: updates.length, updates: updates.slice(0, 50) };
writeFileSync(join(ARTIFACT, 'm8-2-backfill-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
