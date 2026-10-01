-- CreateEnum
CREATE TYPE "SystemDnsMode" AS ENUM ('MANUAL', 'PROVIDER');

-- CreateTable
CREATE TABLE "SystemDomainConfig" (
    "id" TEXT NOT NULL,
    "rootDomain" TEXT NOT NULL,
    "gatewayPublicIp" TEXT,
    "gatewayServerId" TEXT,
    "dnsMode" "SystemDnsMode" NOT NULL DEFAULT 'MANUAL',
    "dnsStatus" "ApplicationDnsStatus" NOT NULL DEFAULT 'PENDING',
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemDomainConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemDomainConfig_rootDomain_idx" ON "SystemDomainConfig"("rootDomain");
