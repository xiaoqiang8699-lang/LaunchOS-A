-- Step 30 Phase 1: LaunchRun / LaunchRunStep orchestration models (plan + dry-run only).

CREATE TYPE "LaunchRunStatus" AS ENUM (
  'DRAFT',
  'PLANNING',
  'READY',
  'RUNNING',
  'WAITING_CONFIRMATION',
  'VERIFYING',
  'SUCCESS',
  'FAILED',
  'CANCELLED',
  'PARTIAL'
);

CREATE TYPE "LaunchTriggerType" AS ENUM ('MANUAL', 'RETRY', 'RESUME', 'REDEPLOY');

CREATE TYPE "LaunchStage" AS ENUM (
  'ANALYZE',
  'DEPENDENCIES',
  'INFRASTRUCTURE',
  'BUILD',
  'DEPLOY',
  'PUBLIC_ENTRY',
  'VERIFY'
);

CREATE TYPE "LaunchStepStatus" AS ENUM (
  'PENDING',
  'READY',
  'RUNNING',
  'WAITING',
  'SKIPPED',
  'SUCCESS',
  'FAILED',
  'BLOCKED'
);

CREATE TYPE "LaunchStepDecision" AS ENUM ('EXECUTE', 'REUSE', 'SKIP', 'BLOCK');

CREATE TABLE "LaunchRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "status" "LaunchRunStatus" NOT NULL DEFAULT 'DRAFT',
    "triggerType" "LaunchTriggerType" NOT NULL DEFAULT 'MANUAL',
    "createdByUserId" TEXT,
    "currentStage" "LaunchStage",
    "currentStep" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "planVersion" TEXT NOT NULL,
    "inputSnapshot" JSONB NOT NULL DEFAULT '{}',
    "planSnapshot" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaunchRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LaunchRunStep" (
    "id" TEXT NOT NULL,
    "launchRunId" TEXT NOT NULL,
    "stage" "LaunchStage" NOT NULL,
    "stepType" TEXT NOT NULL,
    "status" "LaunchStepStatus" NOT NULL DEFAULT 'PENDING',
    "decision" "LaunchStepDecision" NOT NULL DEFAULT 'EXECUTE',
    "executionOrder" INTEGER NOT NULL,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resourceType" TEXT,
    "resourceId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "reconcileKey" TEXT NOT NULL DEFAULT 'default',
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaunchRunStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LaunchRun_projectId_environmentId_status_idx" ON "LaunchRun"("projectId", "environmentId", "status");
CREATE INDEX "LaunchRun_projectId_createdAt_idx" ON "LaunchRun"("projectId", "createdAt");
CREATE INDEX "LaunchRun_createdByUserId_idx" ON "LaunchRun"("createdByUserId");

CREATE INDEX "LaunchRunStep_launchRunId_executionOrder_idx" ON "LaunchRunStep"("launchRunId", "executionOrder");
CREATE INDEX "LaunchRunStep_launchRunId_status_idx" ON "LaunchRunStep"("launchRunId", "status");
CREATE UNIQUE INDEX "LaunchRunStep_launchRunId_stepType_reconcileKey_key" ON "LaunchRunStep"("launchRunId", "stepType", "reconcileKey");

ALTER TABLE "LaunchRun" ADD CONSTRAINT "LaunchRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LaunchRun" ADD CONSTRAINT "LaunchRun_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "ProjectEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LaunchRun" ADD CONSTRAINT "LaunchRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LaunchRunStep" ADD CONSTRAINT "LaunchRunStep_launchRunId_fkey" FOREIGN KEY ("launchRunId") REFERENCES "LaunchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
