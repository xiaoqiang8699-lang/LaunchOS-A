DO $$ BEGIN CREATE TYPE "DeploymentKnowledgeCategory" AS ENUM ('BUILD_ERROR', 'CONFIG_ERROR', 'DEPENDENCY_ERROR', 'DOCKER_ERROR', 'RUNTIME_ERROR', 'NETWORK_ERROR', 'DATABASE_ERROR', 'UNKNOWN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DeploymentKnowledgeSourceType" AS ENUM ('RULE', 'AI_GENERATED', 'ADMIN_CREATED', 'LEARNED_FROM_SUCCESS'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DeploymentKnowledgeCandidateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DeploymentKnowledgeFeedbackResult" AS ENUM ('SUCCESS', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "DeploymentKnowledgeItem" (
    "id" TEXT NOT NULL,
    "category" "DeploymentKnowledgeCategory" NOT NULL DEFAULT 'UNKNOWN',
    "title" TEXT NOT NULL,
    "problemPattern" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rootCause" TEXT NOT NULL,
    "solutionStepsJson" JSONB NOT NULL DEFAULT '[]',
    "sourceType" "DeploymentKnowledgeSourceType" NOT NULL DEFAULT 'RULE',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeploymentKnowledgeItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeploymentKnowledgeCandidate" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "category" "DeploymentKnowledgeCategory" NOT NULL DEFAULT 'UNKNOWN',
    "summary" TEXT NOT NULL,
    "solution" TEXT NOT NULL,
    "status" "DeploymentKnowledgeCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "knowledgeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeploymentKnowledgeCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeploymentKnowledgeFeedback" (
    "id" TEXT NOT NULL,
    "knowledgeId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "userId" TEXT,
    "result" "DeploymentKnowledgeFeedbackResult" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeploymentKnowledgeFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeploymentKnowledgeItem_category_enabled_idx" ON "DeploymentKnowledgeItem"("category", "enabled");
CREATE INDEX IF NOT EXISTS "DeploymentKnowledgeItem_successRate_usageCount_idx" ON "DeploymentKnowledgeItem"("successRate", "usageCount");
CREATE INDEX IF NOT EXISTS "DeploymentKnowledgeItem_title_idx" ON "DeploymentKnowledgeItem"("title");
CREATE INDEX IF NOT EXISTS "DeploymentKnowledgeCandidate_status_createdAt_idx" ON "DeploymentKnowledgeCandidate"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentKnowledgeCandidate_deploymentId_idx" ON "DeploymentKnowledgeCandidate"("deploymentId");
CREATE INDEX IF NOT EXISTS "DeploymentKnowledgeCandidate_category_status_idx" ON "DeploymentKnowledgeCandidate"("category", "status");
CREATE INDEX IF NOT EXISTS "DeploymentKnowledgeFeedback_knowledgeId_createdAt_idx" ON "DeploymentKnowledgeFeedback"("knowledgeId", "createdAt");
CREATE INDEX IF NOT EXISTS "DeploymentKnowledgeFeedback_deploymentId_createdAt_idx" ON "DeploymentKnowledgeFeedback"("deploymentId", "createdAt");

DO $$ BEGIN
  CREATE UNIQUE INDEX "DeploymentKnowledgeFeedback_knowledgeId_deploymentId_key" ON "DeploymentKnowledgeFeedback"("knowledgeId", "deploymentId");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "DeploymentKnowledgeCandidate" ADD CONSTRAINT "DeploymentKnowledgeCandidate_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "DeploymentKnowledgeFeedback" ADD CONSTRAINT "DeploymentKnowledgeFeedback_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "DeploymentKnowledgeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
