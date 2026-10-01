-- CreateEnum
CREATE TYPE "CloudResourceType" AS ENUM ('SERVER', 'DATABASE', 'STORAGE', 'NETWORK');

-- CreateEnum
CREATE TYPE "CloudResourceStatus" AS ENUM ('CREATING', 'RUNNING', 'STOPPED', 'FAILED');

-- AlterTable
ALTER TABLE "ProviderAccount" RENAME COLUMN "credentialsEncrypted" TO "credentialEncrypted";

ALTER TABLE "ProviderAccount" ADD COLUMN "region" TEXT;
ALTER TABLE "ProviderAccount" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ProviderAccount" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "CloudResource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "type" "CloudResourceType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" "CloudResourceStatus" NOT NULL DEFAULT 'CREATING',
    "region" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CloudResource_workspaceId_createdAt_idx" ON "CloudResource"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "CloudResource" ADD CONSTRAINT "CloudResource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudResource" ADD CONSTRAINT "CloudResource_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
