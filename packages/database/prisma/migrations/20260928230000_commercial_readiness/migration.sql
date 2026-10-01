CREATE TYPE "CloudCostResourceType" AS ENUM ('SERVER', 'DATABASE', 'REDIS', 'STORAGE', 'BANDWIDTH', 'DOMAIN', 'OTHER');
CREATE TYPE "CloudCostSource" AS ENUM ('ESTIMATED', 'PROVIDER_BILL', 'MANUAL_IMPORT');
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
CREATE TYPE "DiscountStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');
CREATE TYPE "CommercialOrderType" AS ENUM ('SUBSCRIPTION_NEW', 'SUBSCRIPTION_UPGRADE', 'SUBSCRIPTION_RENEWAL', 'OTHER');
CREATE TYPE "CommercialOrderStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'PAID', 'CANCELED', 'EXPIRED');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

ALTER TABLE "Subscription" ADD COLUMN "paymentStatus" TEXT;

ALTER TABLE "Invoice" ADD COLUMN "invoiceNumber" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "billingProfileSnapshot" JSONB;
ALTER TABLE "Invoice" ADD COLUMN "planVersionSnapshot" JSONB;
ALTER TABLE "Invoice" ADD COLUMN "subscriptionAmount" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "cloudResourceAmount" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "discountAmount" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "taxAmount" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "totalAmount" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "commercialOrderId" TEXT;
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

CREATE TABLE "BillingProfile" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "billingName" TEXT,
  "billingEmail" TEXT,
  "companyName" TEXT,
  "taxId" TEXT,
  "country" TEXT,
  "region" TEXT,
  "city" TEXT,
  "addressLine1" TEXT,
  "addressLine2" TEXT,
  "postalCode" TEXT,
  "contactName" TEXT,
  "contactPhone" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BillingProfile_workspaceId_key" ON "BillingProfile"("workspaceId");
ALTER TABLE "BillingProfile" ADD CONSTRAINT "BillingProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CloudCostRecord" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "resourceType" "CloudCostResourceType" NOT NULL,
  "resourceId" TEXT,
  "provider" TEXT,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "amount" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "estimated" BOOLEAN NOT NULL DEFAULT true,
  "source" "CloudCostSource" NOT NULL DEFAULT 'ESTIMATED',
  "metadataSafe" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CloudCostRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CloudCostRecord_workspaceId_periodStart_idx" ON "CloudCostRecord"("workspaceId", "periodStart");
CREATE INDEX "CloudCostRecord_resourceType_resourceId_idx" ON "CloudCostRecord"("resourceType", "resourceId");
ALTER TABLE "CloudCostRecord" ADD CONSTRAINT "CloudCostRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Discount" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "DiscountType" NOT NULL,
  "value" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "validFrom" TIMESTAMP(3),
  "validUntil" TIMESTAMP(3),
  "status" "DiscountStatus" NOT NULL DEFAULT 'DRAFT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Discount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Discount_code_key" ON "Discount"("code");

CREATE TABLE "CommercialOrder" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "type" "CommercialOrderType" NOT NULL,
  "status" "CommercialOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "planId" TEXT,
  "planVersionId" TEXT,
  "billingInterval" TEXT NOT NULL DEFAULT 'monthly',
  "subscriptionFee" INTEGER,
  "cloudCostEstimate" INTEGER,
  "discountAmount" INTEGER NOT NULL DEFAULT 0,
  "taxAmount" INTEGER,
  "totalAmount" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "upgradeRequestId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "CommercialOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CommercialOrder_orderNumber_key" ON "CommercialOrder"("orderNumber");
CREATE INDEX "CommercialOrder_workspaceId_createdAt_idx" ON "CommercialOrder"("workspaceId", "createdAt");
CREATE INDEX "CommercialOrder_status_createdAt_idx" ON "CommercialOrder"("status", "createdAt");
ALTER TABLE "CommercialOrder" ADD CONSTRAINT "CommercialOrder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialOrder" ADD CONSTRAINT "CommercialOrder_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialOrder" ADD CONSTRAINT "CommercialOrder_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialOrder" ADD CONSTRAINT "CommercialOrder_upgradeRequestId_fkey" FOREIGN KEY ("upgradeRequestId") REFERENCES "UpgradeRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommercialOrder" ADD CONSTRAINT "CommercialOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Payment" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "provider" TEXT,
  "externalPaymentId" TEXT,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Payment_workspaceId_createdAt_idx" ON "Payment"("workspaceId", "createdAt");
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommercialOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
