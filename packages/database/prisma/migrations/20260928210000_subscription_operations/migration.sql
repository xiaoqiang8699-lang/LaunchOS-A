ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'UNCOLLECTIBLE';

ALTER TABLE "Workspace" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE "Workspace" ADD COLUMN "trialConsumedAt" TIMESTAMP(3);

ALTER TABLE "Subscription" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'DEFAULT_FREE';
ALTER TABLE "Subscription" ADD COLUMN "activationSource" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "trialStartedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "pendingPlanId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "planChangeEffectiveAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "fallbackPlanId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "complimentaryUntil" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "complimentaryReason" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "grantedById" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "manualAutoExtension" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Subscription" ADD COLUMN "externalCustomerId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "externalSubscriptionId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "externalPriceId" TEXT;

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_fallbackPlanId_fkey" FOREIGN KEY ("fallbackPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Invoice" ADD COLUMN "source" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "planId" TEXT;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SubscriptionEvent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "fromPlanId" TEXT,
  "toPlanId" TEXT,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "actorUserId" TEXT,
  "source" TEXT NOT NULL,
  "metadataSafe" JSONB NOT NULL DEFAULT '{}',
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubscriptionEvent_idempotencyKey_key" ON "SubscriptionEvent"("idempotencyKey");
CREATE INDEX "SubscriptionEvent_workspaceId_createdAt_idx" ON "SubscriptionEvent"("workspaceId", "createdAt");
CREATE INDEX "SubscriptionEvent_subscriptionId_createdAt_idx" ON "SubscriptionEvent"("subscriptionId", "createdAt");
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "NotificationIntent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "periodKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationIntent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationIntent_workspaceId_type_periodKey_key" ON "NotificationIntent"("workspaceId", "type", "periodKey");
ALTER TABLE "NotificationIntent" ADD CONSTRAINT "NotificationIntent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
