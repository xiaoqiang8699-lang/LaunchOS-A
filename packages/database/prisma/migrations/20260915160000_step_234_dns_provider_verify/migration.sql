-- AlterTable
ALTER TABLE "ProviderAccount" ADD COLUMN "label" TEXT;

-- AlterTable
ALTER TABLE "SystemDomainConfig" ADD COLUMN "dnsProviderVerifiedAt" TIMESTAMP(3),
ADD COLUMN "dnsProviderTxtTestAt" TIMESTAMP(3);
