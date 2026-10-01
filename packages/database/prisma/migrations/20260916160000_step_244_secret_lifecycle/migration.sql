-- Step 24.4: Secret lifecycle audit + rotation metadata

CREATE TYPE "SecretAuditAction" AS ENUM (
  'CREATED',
  'UPDATED',
  'DELETED',
  'PROMOTED_TO_PROJECT',
  'RESTORED_SHARED'
);

ALTER TABLE "RuntimeConfigValue"
  ADD COLUMN "lastRotatedAt" TIMESTAMP(3),
  ADD COLUMN "rotationIntervalDays" INTEGER;

CREATE TABLE "SecretAuditEvent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "deployableUnitId" TEXT,
  "scopeType" "RuntimeConfigScopeType" NOT NULL,
  "scopeId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "action" "SecretAuditAction" NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SecretAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecretAuditEvent_projectId_createdAt_idx" ON "SecretAuditEvent"("projectId", "createdAt");
CREATE INDEX "SecretAuditEvent_projectId_key_idx" ON "SecretAuditEvent"("projectId", "key");
CREATE INDEX "SecretAuditEvent_projectId_deployableUnitId_idx" ON "SecretAuditEvent"("projectId", "deployableUnitId");

ALTER TABLE "SecretAuditEvent"
  ADD CONSTRAINT "SecretAuditEvent_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
