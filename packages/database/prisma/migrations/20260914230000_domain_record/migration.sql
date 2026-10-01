-- CreateEnum
CREATE TYPE "DomainType" AS ENUM ('CUSTOM', 'SUBDOMAIN');

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "CertificateStatus" AS ENUM ('REQUESTING', 'ACTIVE', 'EXPIRED', 'FAILED');

-- DropForeignKey
ALTER TABLE "Certificate" DROP CONSTRAINT "Certificate_domainId_fkey";

-- DropForeignKey
ALTER TABLE "Domain" DROP CONSTRAINT "Domain_projectId_fkey";

-- DropTable
DROP TABLE "Certificate";

-- DropTable
DROP TABLE "Domain";

-- CreateTable
CREATE TABLE "DomainRecord" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "serviceInstanceId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "type" "DomainType" NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" "CertificateStatus" NOT NULL DEFAULT 'REQUESTING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DomainRecord_domain_key" ON "DomainRecord"("domain");

-- CreateIndex
CREATE INDEX "DomainRecord_projectId_createdAt_idx" ON "DomainRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Certificate_domainId_createdAt_idx" ON "Certificate"("domainId", "createdAt");

-- AddForeignKey
ALTER TABLE "DomainRecord" ADD CONSTRAINT "DomainRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainRecord" ADD CONSTRAINT "DomainRecord_serviceInstanceId_fkey" FOREIGN KEY ("serviceInstanceId") REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "DomainRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
