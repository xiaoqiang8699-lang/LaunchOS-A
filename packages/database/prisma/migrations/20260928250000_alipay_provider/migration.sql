ALTER TABLE "Payment" ADD COLUMN "merchantOrderNo" TEXT;
ALTER TABLE "Payment" ADD COLUMN "providerTradeNo" TEXT;
ALTER TABLE "Payment" ADD COLUMN "providerRequestId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "environment" TEXT;
ALTER TABLE "Payment" ADD COLUMN "lastQueryState" TEXT;
ALTER TABLE "Payment" ADD COLUMN "lastQueriedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Payment_merchantOrderNo_key" ON "Payment"("merchantOrderNo");
CREATE INDEX "Payment_provider_status_createdAt_idx" ON "Payment"("provider", "status", "createdAt");

CREATE TABLE "PaymentProviderAccount" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "appId" TEXT,
    "gatewayUrl" TEXT,
    "notifyUrl" TEXT,
    "returnUrl" TEXT,
    "publicKey" TEXT,
    "credentialEncrypted" TEXT,
    "appReady" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'UNCONFIGURED',
    "lastVerifiedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastWebhookAt" TIMESTAMP(3),
    "lastWebhookStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentProviderAccount_provider_environment_key" ON "PaymentProviderAccount"("provider", "environment");
