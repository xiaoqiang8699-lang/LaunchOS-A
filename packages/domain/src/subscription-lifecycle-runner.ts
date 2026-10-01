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

export async function processSubscriptionLifecycle(prisma: PrismaClient, now = new Date()): Promise<{ processed: number }> {
  const free = await prisma.plan.findUnique({ where: { code: 'free' } });
  if (!free) return { processed: 0 };
  const due = await prisma.subscription.findMany({
    where: {
      OR: [
        { status: 'TRIALING', trialEndsAt: { lte: now } },
        { source: 'COMPLIMENTARY', complimentaryUntil: { lte: now } },
        {
          currentPeriodEnd: { lte: now },
          OR: [
            { pendingPlanId: { not: null } },
            { cancelAtPeriodEnd: true },
            { status: 'CANCEL_AT_PERIOD_END' },
            { source: { in: ['MANUAL_ADMIN', 'PAYMENT_PROVIDER'] }, plan: { code: { not: 'free' } } },
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
    const before = toState(row);
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

  const watching = await prisma.subscription.findMany({
    where: {
      OR: [
        { status: 'TRIALING' },
        { status: 'CANCEL_AT_PERIOD_END' },
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
  return { processed };
}
