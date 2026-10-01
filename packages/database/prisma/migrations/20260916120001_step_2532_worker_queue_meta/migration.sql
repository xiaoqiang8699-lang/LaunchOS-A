-- Step 25.3.2: worker queue consumer readiness metadata
ALTER TABLE "WorkerHeartbeat" ADD COLUMN IF NOT EXISTS "meta" JSONB;
