DO $$ BEGIN CREATE TYPE "DeploymentPreflightStatus" AS ENUM ('PASSED', 'WARNING', 'BLOCKED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DeploymentPreflightRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DeploymentPreflightCategory" AS ENUM ('CONFIG', 'DEPENDENCY', 'FRAMEWORK', 'DOCKER', 'RUNTIME'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DeploymentPreflightSeverity" AS ENUM ('INFO', 'WARNING', 'BLOCKER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "DeploymentPreflight" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "deployableUnitId" TEXT,
    "status" "DeploymentPreflightStatus" NOT NULL DEFAULT 'PASSED',
    "riskLevel" "DeploymentPreflightRiskLevel" NOT NULL DEFAULT 'LOW',
    "checksJson" JSONB NOT NULL DEFAULT '[]',
    "recommendationsJson" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "source" TEXT NOT NULL DEFAULT 'RULE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeploymentPreflight_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeploymentPreflightRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "DeploymentPreflightCategory" NOT NULL,
    "pattern" TEXT NOT NULL,
    "severity" "DeploymentPreflightSeverity" NOT NULL DEFAULT 'WARNING',
    "description" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeploymentPreflightRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeploymentPreflight_projectId_createdAt_idx" ON "DeploymentPreflight"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentPreflight_deployableUnitId_createdAt_idx" ON "DeploymentPreflight"("deployableUnitId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentPreflight_status_createdAt_idx" ON "DeploymentPreflight"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentPreflight_riskLevel_createdAt_idx" ON "DeploymentPreflight"("riskLevel", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentPreflightRule_enabled_category_idx" ON "DeploymentPreflightRule"("enabled", "category");
CREATE INDEX IF NOT EXISTS "DeploymentPreflightRule_name_idx" ON "DeploymentPreflightRule"("name");

DO $$ BEGIN
  ALTER TABLE "DeploymentPreflight" ADD CONSTRAINT "DeploymentPreflight_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "DeploymentPreflight" ADD CONSTRAINT "DeploymentPreflight_deployableUnitId_fkey" FOREIGN KEY ("deployableUnitId") REFERENCES "DeployableUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
