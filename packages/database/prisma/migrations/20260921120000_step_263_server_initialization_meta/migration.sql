-- Step 26.3: ServerInstance.metadata for initialization facts (non-secret)
ALTER TABLE "ServerInstance" ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';
