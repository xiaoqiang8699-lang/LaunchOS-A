-- Step 27.1: explicit deployment target type (LOCAL | MANAGED_SERVER)
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "targetType" TEXT NOT NULL DEFAULT 'LOCAL';
