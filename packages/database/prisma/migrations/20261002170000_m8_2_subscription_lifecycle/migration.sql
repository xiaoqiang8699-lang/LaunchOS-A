-- M8-2 Subscription Lifecycle
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'GRACE_PERIOD';

ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "billingCycle" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "gracePeriodEnd" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "expiredAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "canceledAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "latestPaymentId" TEXT;

CREATE INDEX IF NOT EXISTS "Subscription_gracePeriodEnd_idx" ON "Subscription"("gracePeriodEnd");
CREATE INDEX IF NOT EXISTS "Subscription_currentPeriodEnd_status_idx" ON "Subscription"("currentPeriodEnd", "status");

CREATE TABLE IF NOT EXISTS "SubscriptionChangeRequest" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "fromPlanVersionId" TEXT,
  "toPlanVersionId" TEXT,
  "fromPlanId" TEXT,
  "toPlanId" TEXT,
  "fromBillingCycle" TEXT,
  "toBillingCycle" TEXT,
  "changeType" TEXT NOT NULL,
  "effectiveMode" TEXT NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "metadataSafe" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "SubscriptionChangeRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionChangeRequest_idempotencyKey_key" ON "SubscriptionChangeRequest"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "SubscriptionChangeRequest_subscriptionId_status_idx" ON "SubscriptionChangeRequest"("subscriptionId", "status");
CREATE INDEX IF NOT EXISTS "SubscriptionChangeRequest_workspaceId_status_idx" ON "SubscriptionChangeRequest"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "SubscriptionChangeRequest_effectiveAt_status_idx" ON "SubscriptionChangeRequest"("effectiveAt", "status");

DO $$ BEGIN
  ALTER TABLE "SubscriptionChangeRequest" ADD CONSTRAINT "SubscriptionChangeRequest_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "SubscriptionChangeRequest" ADD CONSTRAINT "SubscriptionChangeRequest_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
