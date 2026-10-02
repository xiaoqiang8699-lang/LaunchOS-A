import { Prisma, PrismaClient, SubscriptionStatus } from '@launchos/database';
import { nextLifecyclePatch, notificationIntents, type LifecycleState } from './subscription-operations';

type DueRow = {
  id: string;
  workspaceId: string;
  planId: string;
  status: string;
  source: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  complimentaryUntil: Date | null;
  pendingPlanId: string | null;
  planChangeEffectiveAt: Date | null;
  fallbackPlanId: string | null;
  manualAutoExtension: boolean;
  quotaExceeded: boolean;
  gracePeriodEnd: Date | null;
  billingCycle: string | null;
  plan: { code: string };
  pendingPlan: { code: string } | null;
  fallbackPlan: { code: string } | null;
  workspace: { status: string; timezone: string };
};

function toState(row: DueRow): LifecycleState {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    planId: row.planId,
    planCode: row.plan.code,
    pendingPlanId: row.pendingPlanId,
    pendingPlanCode: row.pendingPlan?.code ?? null,
    fallbackPlanId: row.fallbackPlanId,
    fallbackPlanCode: row.fallbackPlan?.code ?? null,
    status: row.status,
    source: row.source,
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    complimentaryUntil: row.complimentaryUntil?.toISOString() ?? null,
    manualAutoExtension: row.manualAutoExtension,
    timeZone: row.workspace.timezone || 'Asia/Shanghai',
    workspaceStatus: row.workspace.status,
    gracePeriodEnd: row.gracePeriodEnd?.toISOString() ?? null,
    billingCycle: row.billingCycle ?? 'NONE',
  };
}

async function saveIntent(prisma: PrismaClient, workspaceId: string, type: string, periodKey: string) {
  try {
    await prisma.notificationIntent.create({ data: { workspaceId, type, periodKey } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
    throw error;
  }
}

/**
 * Apply due SubscriptionChangeRequest rows (upgrade/downgrade/cycle) at effectiveAt.
 * Idempotent via change-request status + subscription event key.
 */
async function applyDueChangeRequests(prisma: PrismaClient, now: Date): Promise<number> {
  const due = await prisma.subscriptionChangeRequest.findMany({
    where: { status: 'PENDING', effectiveAt: { lte: now } },
    take: 200,
    orderBy: { effectiveAt: 'asc' },
  });
  let applied = 0;
  for (const req of due) {
    if (!req.toPlanId) {
      await prisma.subscriptionChangeRequest.update({
        where: { id: req.id },
        data: { status: 'CANCELED', canceledAt: now },
      });
      continue;
    }
    const eventKey = `change-request:${req.id}:applied`;
    const existing = await prisma.subscriptionEvent.findUnique({ where: { idempotencyKey: eventKey } });
    if (existing) {
      await prisma.subscriptionChangeRequest.update({
        where: { id: req.id },
        data: { status: 'APPLIED', appliedAt: existing.effectiveAt },
      });
      continue;
    }
    const version =
      (req.toPlanVersionId
        ? await prisma.planVersion.findUnique({ where: { id: req.toPlanVersionId } })
        : null) ??
      (await prisma.planVersion.findFirst({
        where: { planId: req.toPlanId, effectiveTo: null },
        orderBy: { version: 'desc' },
      }));
    try {
      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: req.subscriptionId },
          data: {
            planId: req.toPlanId!,
            planVersionId: version?.id,
            billingCycle: req.toBillingCycle ?? undefined,
            pendingPlanId: null,
            planChangeEffectiveAt: null,
          },
        });
        await tx.subscriptionChangeRequest.update({
          where: { id: req.id },
          data: { status: 'APPLIED', appliedAt: now },
        });
        await tx.subscriptionEvent.create({
          data: {
            workspaceId: req.workspaceId,
            subscriptionId: req.subscriptionId,
            eventType: 'SUBSCRIPTION_CHANGE_APPLIED',
            fromPlanId: req.fromPlanId,
            toPlanId: req.toPlanId,
            effectiveAt: now,
            source: 'LIFECYCLE_WORKER',
            metadataSafe: {
              changeRequestId: req.id,
              changeType: req.changeType,
              keepsRunningServices: true,
            },
            idempotencyKey: eventKey,
          },
        });
      });
      applied += 1;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
      throw error;
    }
  }
  return applied;
}

export async function processSubscriptionLifecycle(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ processed: number; changeRequestsApplied: number }> {
  const free = await prisma.plan.findUnique({ where: { code: 'free' } });
  if (!free) return { processed: 0, changeRequestsApplied: 0 };
  const due = await prisma.subscription.findMany({
    where: {
      OR: [
        { status: 'TRIALING', trialEndsAt: { lte: now } },
        { source: 'COMPLIMENTARY', complimentaryUntil: { lte: now } },
        { status: 'GRACE_PERIOD', gracePeriodEnd: { lte: now } },
        {
          currentPeriodEnd: { lte: now },
          OR: [
            { pendingPlanId: { not: null } },
            { cancelAtPeriodEnd: true },
            { status: 'CANCEL_AT_PERIOD_END' },
            { status: 'ACTIVE' },
            { source: { in: ['MANUAL_ADMIN', 'PAYMENT_PROVIDER', 'PAYMENT'] }, plan: { code: { not: 'free' } } },
            { manualAutoExtension: true, plan: { code: { not: 'free' } } },
          ],
        },
      ],
    },
    include: {
      plan: true,
      pendingPlan: true,
      fallbackPlan: true,
      workspace: { select: { status: true, timezone: true } },
    },
  });
  let processed = 0;
  for (const row of due) {
    const before = toState(row as DueRow);
    const nextPatch = nextLifecyclePatch(before, now, { id: free.id, code: free.code });
    if (!nextPatch) continue;
    const version = await prisma.planVersion.findFirst({
      where: { planId: nextPatch.next.planId, effectiveTo: null },
      orderBy: { version: 'desc' },
    });
    const existing = await prisma.subscriptionEvent.findUnique({ where: { idempotencyKey: nextPatch.idempotencyKey } });
    if (existing) continue;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: row.id },
          data: {
            planId: nextPatch.next.planId,
            planVersionId: version?.id,
            status: nextPatch.next.status as SubscriptionStatus,
            source: nextPatch.next.source,
            currentPeriodStart: new Date(nextPatch.next.currentPeriodStart),
            currentPeriodEnd: new Date(nextPatch.next.currentPeriodEnd),
            cancelAtPeriodEnd: nextPatch.next.cancelAtPeriodEnd,
            trialEndsAt: nextPatch.next.trialEndsAt ? new Date(nextPatch.next.trialEndsAt) : null,
            complimentaryUntil: nextPatch.next.complimentaryUntil ? new Date(nextPatch.next.complimentaryUntil) : null,
            pendingPlanId: nextPatch.next.pendingPlanId,
            fallbackPlanId: nextPatch.next.fallbackPlanId,
            planChangeEffectiveAt: nextPatch.next.pendingPlanId ? row.planChangeEffectiveAt : null,
            manualAutoExtension: nextPatch.next.manualAutoExtension,
            gracePeriodEnd: nextPatch.next.gracePeriodEnd ? new Date(nextPatch.next.gracePeriodEnd) : null,
            billingCycle: nextPatch.next.billingCycle ?? row.billingCycle ?? 'NONE',
            ...(nextPatch.next.status === 'EXPIRED' ? { expiredAt: now } : {}),
          },
        });
        await tx.subscriptionEvent.create({
          data: {
            workspaceId: row.workspaceId,
            subscriptionId: row.id,
            eventType: nextPatch.eventType,
            fromPlanId: nextPatch.fromPlanId,
            toPlanId: nextPatch.toPlanId,
            effectiveAt: new Date(nextPatch.effectiveAt),
            source: nextPatch.source,
            metadataSafe: { keepsRunningServices: true },
            idempotencyKey: nextPatch.idempotencyKey,
          },
        });
      });
      processed += 1;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
      throw error;
    }
  }

  const changeRequestsApplied = await applyDueChangeRequests(prisma, now);

  const watching = await prisma.subscription.findMany({
    where: {
      OR: [
        { status: 'TRIALING' },
        { status: 'CANCEL_AT_PERIOD_END' },
        { status: 'GRACE_PERIOD' },
        { pendingPlanId: { not: null } },
        { quotaExceeded: true },
      ],
    },
    include: { pendingPlan: true },
    take: 500,
  });
  for (const row of watching) {
    const intents = notificationIntents({
      now,
      trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
      status: row.status,
      currentPeriodEnd: row.currentPeriodEnd.toISOString(),
      pendingPlanCode: row.pendingPlan?.code ?? null,
      quotaNear: row.quotaExceeded,
    });
    for (const intent of intents) {
      await saveIntent(prisma, row.workspaceId, intent.type, intent.periodKey);
    }
  }
  return { processed, changeRequestsApplied };
}
