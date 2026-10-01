-- CreateEnum
CREATE TYPE "ApplicationVersionStatus" AS ENUM ('DEPLOYING', 'ACTIVE', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "CodeUpdateStatus" AS ENUM ('PENDING', 'CONFIRMED', 'IGNORED');

-- AlterTable
ALTER TABLE "Project"
ADD COLUMN "autoDeployEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Deployment"
ADD COLUMN "sourceArtifactId" TEXT;

-- CreateTable
CREATE TABLE "ApplicationVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL DEFAULT '',
    "commitMessage" TEXT NOT NULL DEFAULT '',
    "status" "ApplicationVersionStatus" NOT NULL DEFAULT 'DEPLOYING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingCodeUpdate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "commitMessage" TEXT NOT NULL DEFAULT '',
    "status" "CodeUpdateStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingCodeUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationVersion_deploymentId_key" ON "ApplicationVersion"("deploymentId");

-- CreateIndex
CREATE INDEX "ApplicationVersion_projectId_createdAt_idx" ON "ApplicationVersion"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingCodeUpdate_projectId_commitSha_key" ON "PendingCodeUpdate"("projectId", "commitSha");

-- CreateIndex
CREATE INDEX "PendingCodeUpdate_projectId_createdAt_idx" ON "PendingCodeUpdate"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Deployment_sourceArtifactId_idx" ON "Deployment"("sourceArtifactId");

-- AddForeignKey
ALTER TABLE "ApplicationVersion"
ADD CONSTRAINT "ApplicationVersion_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationVersion"
ADD CONSTRAINT "ApplicationVersion_deploymentId_fkey"
FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingCodeUpdate"
ADD CONSTRAINT "PendingCodeUpdate_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment"
ADD CONSTRAINT "Deployment_sourceArtifactId_fkey"
FOREIGN KEY ("sourceArtifactId") REFERENCES "Artifact"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
