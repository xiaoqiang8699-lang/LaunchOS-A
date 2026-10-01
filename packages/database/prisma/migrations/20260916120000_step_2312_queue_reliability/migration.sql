-- Step 23.12: Worker heartbeat + deployment queue observability

ALTER TYPE "DiagnosisCategory" ADD VALUE IF NOT EXISTS 'QUEUE_ERROR';

CREATE TABLE IF NOT EXISTS "WorkerHeartbeat" (
  "id" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "service" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "version" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkerHeartbeat_workerId_key" ON "WorkerHeartbeat"("workerId");
CREATE INDEX IF NOT EXISTS "WorkerHeartbeat_service_lastSeenAt_idx" ON "WorkerHeartbeat"("service", "lastSeenAt");

ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "bullmqJobId" TEXT;
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP(3);
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "queueStallCount" INTEGER NOT NULL DEFAULT 0;
