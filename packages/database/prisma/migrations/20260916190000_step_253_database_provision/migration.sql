-- Step 25.3: Managed database provisioning (Aliyun RDS)

-- Extend CloudResourceStatus with lifecycle states
ALTER TYPE "CloudResourceStatus" ADD VALUE IF NOT EXISTS 'DELETING';
ALTER TYPE "CloudResourceStatus" ADD VALUE IF NOT EXISTS 'DELETED';

-- Extend DatabaseConnectionStatus with managed-unavailable state
ALTER TYPE "DatabaseConnectionStatus" ADD VALUE IF NOT EXISTS 'UNAVAILABLE';

-- Add managed-connection columns to DatabaseConnection
ALTER TABLE "DatabaseConnection"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "cloudResourceId" TEXT;

-- FK: DatabaseConnection → CloudResource (nullable, set-null on delete)
ALTER TABLE "DatabaseConnection"
  ADD CONSTRAINT "DatabaseConnection_cloudResourceId_fkey"
  FOREIGN KEY ("cloudResourceId") REFERENCES "CloudResource"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "DatabaseConnection_cloudResourceId_idx"
  ON "DatabaseConnection"("cloudResourceId");
