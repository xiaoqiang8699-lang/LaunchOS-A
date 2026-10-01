-- CreateEnum
CREATE TYPE "DiagnosisCategory" AS ENUM ('BUILD_ERROR', 'DEPENDENCY_ERROR', 'CONFIG_ERROR', 'RUNTIME_ERROR', 'PORT_ERROR', 'DATABASE_ERROR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DiagnosisSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "DeploymentDiagnosis" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "category" "DiagnosisCategory" NOT NULL,
    "severity" "DiagnosisSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "solution" TEXT NOT NULL,
    "fixPrompt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentDiagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeploymentDiagnosis_deploymentId_createdAt_idx" ON "DeploymentDiagnosis"("deploymentId", "createdAt");

-- AddForeignKey
ALTER TABLE "DeploymentDiagnosis" ADD CONSTRAINT "DeploymentDiagnosis_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
