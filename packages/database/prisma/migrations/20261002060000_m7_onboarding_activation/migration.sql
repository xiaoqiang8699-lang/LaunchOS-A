DO $$ BEGIN CREATE TYPE "UserActivationStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'AT_RISK', 'ACTIVATED', 'DORMANT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "UserActivationStage" AS ENUM ('REGISTERED', 'WORKSPACE_READY', 'PROJECT_CREATED', 'SOURCE_CONNECTED', 'ANALYSIS_COMPLETED', 'CONFIG_COMPLETED', 'PREFLIGHT_PASSED', 'FIRST_DEPLOY_STARTED', 'FIRST_DEPLOY_SUCCEEDED', 'PUBLIC_ENTRY_READY', 'ACTIVATED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "OnboardingStepStatus" AS ENUM ('ENTERED', 'COMPLETED', 'BLOCKED', 'ABANDONED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "OnboardingBlockerCategory" AS ENUM ('SOURCE', 'CONFIG', 'PREFLIGHT', 'BUILD', 'RUNTIME', 'DOMAIN', 'PERMISSION', 'QUOTA', 'UNKNOWN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "OnboardingRecommendationCategory" AS ENUM ('SOURCE_FLOW', 'CONFIG_FLOW', 'PREFLIGHT', 'DEPLOYMENT', 'PUBLIC_ENTRY', 'ONBOARDING_COPY', 'DOCUMENTATION', 'UNKNOWN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "OnboardingRecommendationScope" AS ENUM ('PLATFORM', 'SEGMENT', 'USER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "OnboardingRecommendationPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "OnboardingRecommendationStatus" AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED', 'IMPLEMENTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "UserActivationState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "projectId" TEXT,
    "currentStage" "UserActivationStage" NOT NULL DEFAULT 'REGISTERED',
    "status" "UserActivationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "activatedAt" TIMESTAMP(3),
    "firstProjectAt" TIMESTAMP(3),
    "firstDeployStartedAt" TIMESTAMP(3),
    "firstDeploySucceededAt" TIMESTAMP(3),
    "firstPublicSuccessAt" TIMESTAMP(3),
    "lastProgressAt" TIMESTAMP(3),
    "blockedSince" TIMESTAMP(3),
    "primaryBlocker" TEXT,
    "blockerCategory" "OnboardingBlockerCategory",
    "activationScore" INTEGER NOT NULL DEFAULT 0,
    "scoreExplanationJson" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserActivationState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserActivationState_userId_key" ON "UserActivationState"("userId");
CREATE INDEX IF NOT EXISTS "UserActivationState_status_currentStage_idx" ON "UserActivationState"("status", "currentStage");
CREATE INDEX IF NOT EXISTS "UserActivationState_workspaceId_idx" ON "UserActivationState"("workspaceId");
CREATE INDEX IF NOT EXISTS "UserActivationState_projectId_idx" ON "UserActivationState"("projectId");
CREATE INDEX IF NOT EXISTS "UserActivationState_lastProgressAt_idx" ON "UserActivationState"("lastProgressAt");
CREATE INDEX IF NOT EXISTS "UserActivationState_activationScore_idx" ON "UserActivationState"("activationScore");

CREATE TABLE IF NOT EXISTS "OnboardingStepSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "projectId" TEXT,
    "stage" "UserActivationStage" NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "status" "OnboardingStepStatus" NOT NULL DEFAULT 'ENTERED',
    "blockerCategory" "OnboardingBlockerCategory",
    "source" TEXT NOT NULL DEFAULT 'PROJECTION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingStepSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OnboardingStepSnapshot_userId_stage_status_key" ON "OnboardingStepSnapshot"("userId", "stage", "status");
CREATE INDEX IF NOT EXISTS "OnboardingStepSnapshot_userId_stage_idx" ON "OnboardingStepSnapshot"("userId", "stage");
CREATE INDEX IF NOT EXISTS "OnboardingStepSnapshot_stage_status_idx" ON "OnboardingStepSnapshot"("stage", "status");
CREATE INDEX IF NOT EXISTS "OnboardingStepSnapshot_blockerCategory_createdAt_idx" ON "OnboardingStepSnapshot"("blockerCategory", "createdAt");

CREATE TABLE IF NOT EXISTS "OnboardingOptimizationRecommendation" (
    "id" TEXT NOT NULL,
    "category" "OnboardingRecommendationCategory" NOT NULL DEFAULT 'UNKNOWN',
    "scope" "OnboardingRecommendationScope" NOT NULL DEFAULT 'PLATFORM',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidenceJson" JSONB NOT NULL DEFAULT '{}',
    "affectedUsers" INTEGER NOT NULL DEFAULT 0,
    "estimatedImpact" TEXT NOT NULL DEFAULT '',
    "priority" "OnboardingRecommendationPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "OnboardingRecommendationStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OnboardingOptimizationRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OnboardingOptimizationRecommendation_status_priority_idx" ON "OnboardingOptimizationRecommendation"("status", "priority");
CREATE INDEX IF NOT EXISTS "OnboardingOptimizationRecommendation_category_createdAt_idx" ON "OnboardingOptimizationRecommendation"("category", "createdAt");

DO $$ BEGIN
  ALTER TABLE "UserActivationState" ADD CONSTRAINT "UserActivationState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OnboardingStepSnapshot" ADD CONSTRAINT "OnboardingStepSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
