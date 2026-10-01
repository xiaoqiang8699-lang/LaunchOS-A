-- Step 28: deployment reliability & safe release pointers
ALTER TABLE "ProjectEnvironment"
  ADD COLUMN IF NOT EXISTS "activeDeploymentId" TEXT,
  ADD COLUMN IF NOT EXISTS "previousDeploymentId" TEXT;

ALTER TABLE "Deployment"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "executionAttemptId" TEXT,
  ADD COLUMN IF NOT EXISTS "currentStage" TEXT,
  ADD COLUMN IF NOT EXISTS "failureCode" TEXT,
  ADD COLUMN IF NOT EXISTS "stageHistory" JSONB,
  ADD COLUMN IF NOT EXISTS "releaseLabel" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Deployment_idempotencyKey_key"
  ON "Deployment"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "Deployment_projectId_environmentId_status_idx"
  ON "Deployment"("projectId", "environmentId", "status");
