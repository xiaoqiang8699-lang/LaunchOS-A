DO $$ BEGIN CREATE TYPE "DeploymentInsightCategory" AS ENUM ('BUILD_ERROR', 'DEPENDENCY_ERROR', 'CONFIG_ERROR', 'RUNTIME_ERROR', 'NETWORK_ERROR', 'PLATFORM_ERROR', 'UNKNOWN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "DeploymentInsight" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "category" "DeploymentInsightCategory" NOT NULL DEFAULT 'UNKNOWN',
    "summary" TEXT NOT NULL,
    "rootCause" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "fixActionsJson" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "source" TEXT NOT NULL DEFAULT 'RULE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeploymentInsight_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeploymentDiagnosisRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "category" "DeploymentInsightCategory" NOT NULL,
    "explanation" TEXT NOT NULL,
    "fixTemplate" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeploymentDiagnosisRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeploymentInsight_deploymentId_createdAt_idx" ON "DeploymentInsight"("deploymentId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentInsight_category_createdAt_idx" ON "DeploymentInsight"("category", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentDiagnosisRule_enabled_category_idx" ON "DeploymentDiagnosisRule"("enabled", "category");
CREATE INDEX IF NOT EXISTS "DeploymentDiagnosisRule_name_idx" ON "DeploymentDiagnosisRule"("name");

DO $$ BEGIN
  ALTER TABLE "DeploymentInsight" ADD CONSTRAINT "DeploymentInsight_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
