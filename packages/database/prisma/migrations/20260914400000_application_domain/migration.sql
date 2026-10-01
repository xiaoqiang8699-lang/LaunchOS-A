-- CreateEnum
CREATE TYPE "ApplicationDomainType" AS ENUM ('SYSTEM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ApplicationDomainStatus" AS ENUM ('CREATING', 'ACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "ApplicationSslStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED');

-- CreateTable
CREATE TABLE "ApplicationDomain" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "type" "ApplicationDomainType" NOT NULL,
    "status" "ApplicationDomainStatus" NOT NULL DEFAULT 'CREATING',
    "sslStatus" "ApplicationSslStatus" NOT NULL DEFAULT 'PENDING',
    "runtimeHost" TEXT,
    "runtimePort" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationDomain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationDomain_domain_key" ON "ApplicationDomain"("domain");

-- CreateIndex
CREATE INDEX "ApplicationDomain_projectId_createdAt_idx" ON "ApplicationDomain"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "ApplicationDomain" ADD CONSTRAINT "ApplicationDomain_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
