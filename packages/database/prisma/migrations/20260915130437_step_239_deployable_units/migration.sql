-- CreateEnum
CREATE TYPE "DeployableUnitType" AS ENUM ('WEB', 'API', 'ADMIN', 'IOS', 'ANDROID', 'MINI_PROGRAM', 'MOBILE_CROSS_PLATFORM', 'OTHER');

-- CreateEnum
CREATE TYPE "DeployableUnitStatus" AS ENUM ('DETECTED', 'CONFIRMED', 'IGNORED', 'UNSUPPORTED');

-- AlterTable
ALTER TABLE "ApplicationDomain" ADD COLUMN     "deployableUnitId" TEXT;

-- AlterTable
ALTER TABLE "ApplicationVersion" ADD COLUMN     "deployableUnitId" TEXT;

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "deployableUnitId" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "selectedDeployableUnitId" TEXT;

-- AlterTable
ALTER TABLE "ProjectAnalysis" ADD COLUMN     "primaryUnitId" TEXT;

-- AlterTable
ALTER TABLE "ProviderAccount" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ServiceInstance" ADD COLUMN     "deployableUnitId" TEXT;

-- CreateTable
CREATE TABLE "DeployableUnit" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceRepositoryId" TEXT,
    "name" TEXT NOT NULL,
    "type" "DeployableUnitType" NOT NULL,
    "rootPath" TEXT NOT NULL,
    "framework" TEXT,
    "packageManager" TEXT,
    "buildCommand" TEXT,
    "startCommand" TEXT,
    "outputPath" TEXT,
    "port" INTEGER,
    "deployable" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "DeployableUnitStatus" NOT NULL DEFAULT 'DETECTED',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeployableUnit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeployableUnit_projectId_status_idx" ON "DeployableUnit"("projectId", "status");

-- CreateIndex
CREATE INDEX "DeployableUnit_sourceRepositoryId_idx" ON "DeployableUnit"("sourceRepositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "DeployableUnit_projectId_rootPath_key" ON "DeployableUnit"("projectId", "rootPath");

-- CreateIndex
CREATE INDEX "ApplicationDomain_deployableUnitId_idx" ON "ApplicationDomain"("deployableUnitId");

-- CreateIndex
CREATE INDEX "ApplicationVersion_deployableUnitId_idx" ON "ApplicationVersion"("deployableUnitId");

-- CreateIndex
CREATE INDEX "Deployment_deployableUnitId_idx" ON "Deployment"("deployableUnitId");

-- CreateIndex
CREATE INDEX "ProjectAnalysis_primaryUnitId_idx" ON "ProjectAnalysis"("primaryUnitId");

-- CreateIndex
CREATE INDEX "ServiceInstance_deployableUnitId_idx" ON "ServiceInstance"("deployableUnitId");

-- AddForeignKey
ALTER TABLE "DeployableUnit" ADD CONSTRAINT "DeployableUnit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeployableUnit" ADD CONSTRAINT "DeployableUnit_sourceRepositoryId_fkey" FOREIGN KEY ("sourceRepositoryId") REFERENCES "SourceRepository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_deployableUnitId_fkey" FOREIGN KEY ("deployableUnitId") REFERENCES "DeployableUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAnalysis" ADD CONSTRAINT "ProjectAnalysis_primaryUnitId_fkey" FOREIGN KEY ("primaryUnitId") REFERENCES "DeployableUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationVersion" ADD CONSTRAINT "ApplicationVersion_deployableUnitId_fkey" FOREIGN KEY ("deployableUnitId") REFERENCES "DeployableUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceInstance" ADD CONSTRAINT "ServiceInstance_deployableUnitId_fkey" FOREIGN KEY ("deployableUnitId") REFERENCES "DeployableUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDomain" ADD CONSTRAINT "ApplicationDomain_deployableUnitId_fkey" FOREIGN KEY ("deployableUnitId") REFERENCES "DeployableUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
