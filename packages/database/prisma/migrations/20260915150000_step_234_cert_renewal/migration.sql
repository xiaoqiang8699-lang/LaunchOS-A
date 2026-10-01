-- CreateEnum
CREATE TYPE "SystemRenewalMode" AS ENUM ('MANUAL_DNS', 'AUTOMATIC_DNS');

-- CreateEnum
CREATE TYPE "SystemRenewalStatus" AS ENUM ('IDLE', 'PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'ROLLBACK', 'CLEANUP_WARNING');

-- CreateEnum
CREATE TYPE "CertificateRenewalJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'ROLLBACK', 'CLEANUP_WARNING');

-- AlterTable
ALTER TABLE "SystemDomainConfig" ADD COLUMN "dnsProvider" TEXT,
ADD COLUMN "dnsProviderAccountId" TEXT,
ADD COLUMN "renewalMode" "SystemRenewalMode" NOT NULL DEFAULT 'MANUAL_DNS',
ADD COLUMN "renewalStatus" "SystemRenewalStatus" NOT NULL DEFAULT 'IDLE',
ADD COLUMN "lastRenewalAt" TIMESTAMP(3),
ADD COLUMN "lastRenewalResult" TEXT;

-- CreateTable
CREATE TABLE "CertificateRenewal" (
    "id" TEXT NOT NULL,
    "rootDomain" TEXT NOT NULL,
    "certificateDomain" TEXT NOT NULL,
    "status" "CertificateRenewalJobStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "oldExpiresAt" TIMESTAMP(3),
    "newExpiresAt" TIMESTAMP(3),
    "issuer" TEXT,
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificateRenewal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CertificateRenewal_rootDomain_startedAt_idx" ON "CertificateRenewal"("rootDomain", "startedAt");

-- CreateIndex
CREATE INDEX "CertificateRenewal_status_startedAt_idx" ON "CertificateRenewal"("status", "startedAt");
