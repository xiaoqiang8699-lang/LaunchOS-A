CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

ALTER TABLE "CommercialOrder" ADD COLUMN "amountLockedAt" TIMESTAMP(3);
ALTER TABLE "CommercialOrder" ADD COLUMN "fulfillmentLockedAt" TIMESTAMP(3);
ALTER TABLE "CommercialOrder" ADD COLUMN "fulfillmentFailOnce" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CommercialOrder" ADD COLUMN "fulfilledAt" TIMESTAMP(3);

ALTER TABLE "Payment" ADD COLUMN "providerCheckoutId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Payment" ADD COLUMN "isTestPayment" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ADD COLUMN "failureCode" TEXT;
ALTER TABLE "Payment" ADD COLUMN "failureMessageSafe" TEXT;
ALTER TABLE "Payment" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Payment" ADD COLUMN "failedAt" TIMESTAMP(3);
CREATE INDEX "Payment_provider_externalPaymentId_idx" ON "Payment"("provider", "externalPaymentId");

CREATE UNIQUE INDEX "Invoice_commercialOrderId_key" ON "Invoice"("commercialOrderId");
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_commercialOrderId_fkey" FOREIGN KEY ("commercialOrderId") REFERENCES "CommercialOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PaymentWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "paymentId" TEXT,
  CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_externalEventId_key" ON "PaymentWebhookEvent"("provider", "externalEventId");
CREATE INDEX "PaymentWebhookEvent_paymentId_idx" ON "PaymentWebhookEvent"("paymentId");
ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Refund" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "providerRefundId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "refundedAt" TIMESTAMP(3),
  CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommercialOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
