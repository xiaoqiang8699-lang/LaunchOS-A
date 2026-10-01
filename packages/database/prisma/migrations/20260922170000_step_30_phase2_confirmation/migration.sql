-- Step 30 Phase 2: confirmation snapshot + RECONCILING step status.

DO $$ BEGIN
  ALTER TYPE "LaunchStepStatus" ADD VALUE 'RECONCILING';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "LaunchRun" ADD COLUMN IF NOT EXISTS "confirmationId" TEXT;
ALTER TABLE "LaunchRun" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3);
ALTER TABLE "LaunchRun" ADD COLUMN IF NOT EXISTS "confirmedByUserId" TEXT;
ALTER TABLE "LaunchRun" ADD COLUMN IF NOT EXISTS "confirmedPlanHash" TEXT;
ALTER TABLE "LaunchRun" ADD COLUMN IF NOT EXISTS "confirmationSnapshot" JSONB;

CREATE INDEX IF NOT EXISTS "LaunchRun_confirmationId_idx" ON "LaunchRun"("confirmationId");
