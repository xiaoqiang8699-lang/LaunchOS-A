DO $$ BEGIN CREATE TYPE "DeploymentSuccessStatus" AS ENUM ('SUCCESS', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DeploymentSuccessPatternType" AS ENUM ('FRAMEWORK_PATTERN', 'CONFIG_PATTERN', 'PROJECT_PATTERN', 'USER_BEHAVIOR_PATTERN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DeploymentFunnelStage" AS ENUM ('SOURCE_CONNECTED', 'CONFIG_COMPLETED', 'PREFLIGHT_COMPLETED', 'DEPLOY_STARTED', 'BUILD_SUCCESS', 'RUNTIME_HEALTHY'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DeploymentOptimizationCategory" AS ENUM ('ONBOARDING', 'CONFIG', 'BUILD', 'RUNTIME', 'DOCUMENTATION'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "DeploymentKnowledgeItem" ADD COLUMN IF NOT EXISTS "successImpact" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "DeploymentSuccessSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "framework" TEXT,
    "language" TEXT,
    "deploymentStatus" "DeploymentSuccessStatus" NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "failureCategory" TEXT,
    "deploymentDuration" INTEGER,
    "deploymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeploymentSuccessSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeploymentSuccessPattern" (
    "id" TEXT NOT NULL,
    "patternType" "DeploymentSuccessPatternType" NOT NULL,
    "framework" TEXT,
    "conditionJson" JSONB NOT NULL DEFAULT '{}',
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeploymentSuccessPattern_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeploymentFunnelEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "stage" "DeploymentFunnelStage" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeploymentFunnelEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeploymentOptimizationRecommendation" (
    "id" TEXT NOT NULL,
    "category" "DeploymentOptimizationCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeploymentOptimizationRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeploymentSuccessSnapshot_workspaceId_createdAt_idx" ON "DeploymentSuccessSnapshot"("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentSuccessSnapshot_projectId_createdAt_idx" ON "DeploymentSuccessSnapshot"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentSuccessSnapshot_framework_success_idx" ON "DeploymentSuccessSnapshot"("framework", "success");
CREATE INDEX IF NOT EXISTS "DeploymentSuccessSnapshot_deploymentStatus_createdAt_idx" ON "DeploymentSuccessSnapshot"("deploymentStatus", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentSuccessSnapshot_failureCategory_createdAt_idx" ON "DeploymentSuccessSnapshot"("failureCategory", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentSuccessPattern_patternType_framework_idx" ON "DeploymentSuccessPattern"("patternType", "framework");
CREATE INDEX IF NOT EXISTS "DeploymentSuccessPattern_successRate_sampleCount_idx" ON "DeploymentSuccessPattern"("successRate", "sampleCount");
CREATE INDEX IF NOT EXISTS "DeploymentFunnelEvent_workspaceId_createdAt_idx" ON "DeploymentFunnelEvent"("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentFunnelEvent_projectId_createdAt_idx" ON "DeploymentFunnelEvent"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentFunnelEvent_stage_createdAt_idx" ON "DeploymentFunnelEvent"("stage", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentOptimizationRecommendation_category_priority_idx" ON "DeploymentOptimizationRecommendation"("category", "priority");
CREATE INDEX IF NOT EXISTS "DeploymentOptimizationRecommendation_createdAt_idx" ON "DeploymentOptimizationRecommendation"("createdAt");

DO $$ BEGIN
  ALTER TABLE "DeploymentSuccessSnapshot" ADD CONSTRAINT "DeploymentSuccessSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DeploymentSuccessSnapshot" ADD CONSTRAINT "DeploymentSuccessSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DeploymentFunnelEvent" ADD CONSTRAINT "DeploymentFunnelEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DeploymentFunnelEvent" ADD CONSTRAINT "DeploymentFunnelEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
