-- M8-3 Formal Payment Launch Readiness
ALTER TABLE "CommercialOrder" ADD COLUMN IF NOT EXISTS "termsVersion" TEXT;
ALTER TABLE "CommercialOrder" ADD COLUMN IF NOT EXISTS "priceSnapshot" JSONB;
ALTER TABLE "CommercialOrder" ADD COLUMN IF NOT EXISTS "purchaseIntentId" TEXT;

CREATE TABLE IF NOT EXISTS "PurchaseIntent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "planId" TEXT,
  "planVersionId" TEXT,
  "planCode" TEXT NOT NULL,
  "billingCycle" TEXT NOT NULL,
  "amountFen" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "termsVersion" TEXT NOT NULL,
  "termsAcceptedAt" TIMESTAMP(3),
  "priceSnapshot" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'CREATED',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PaymentAccessAllowlist" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "note" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentAccessAllowlist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PlatformPaymentControl" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "accessMode" TEXT NOT NULL DEFAULT 'DISABLED',
  "percentage" INTEGER NOT NULL DEFAULT 0,
  "realPaymentsEnabledOverride" BOOLEAN,
  "notes" TEXT,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformPaymentControl_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAccessAllowlist_workspaceId_key" ON "PaymentAccessAllowlist"("workspaceId");
CREATE INDEX IF NOT EXISTS "PurchaseIntent_workspaceId_status_createdAt_idx" ON "PurchaseIntent"("workspaceId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "PurchaseIntent_userId_status_idx" ON "PurchaseIntent"("userId", "status");
CREATE INDEX IF NOT EXISTS "PurchaseIntent_expiresAt_status_idx" ON "PurchaseIntent"("expiresAt", "status");
CREATE INDEX IF NOT EXISTS "PaymentAccessAllowlist_expiresAt_idx" ON "PaymentAccessAllowlist"("expiresAt");

DO $$ BEGIN
  ALTER TABLE "PurchaseIntent" ADD CONSTRAINT "PurchaseIntent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PaymentAccessAllowlist" ADD CONSTRAINT "PaymentAccessAllowlist_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO "PlatformPaymentControl" ("id", "accessMode", "percentage", "createdAt", "updatedAt")
VALUES ('default', 'DISABLED', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;