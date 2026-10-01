CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

ALTER TABLE "Workspace" ADD COLUMN "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Workspace" ADD COLUMN "adminNote" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "Workspace" ADD COLUMN "suspendedById" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "suspendReason" TEXT;
CREATE INDEX "Workspace_status_createdAt_idx" ON "Workspace"("status", "createdAt");
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_suspendedById_fkey" FOREIGN KEY ("suspendedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Plan" ADD COLUMN "maxProjects" INTEGER;
ALTER TABLE "Plan" ADD COLUMN "maxMembers" INTEGER;
ALTER TABLE "Plan" ADD COLUMN "maxDeploymentsPerMonth" INTEGER;
ALTER TABLE "Plan" ADD COLUMN "maxBuildMinutesPerMonth" INTEGER;
ALTER TABLE "Plan" ADD COLUMN "maxServers" INTEGER;
ALTER TABLE "Plan" ADD COLUMN "maxDatabases" INTEGER;
ALTER TABLE "Plan" ADD COLUMN "maxRedisInstances" INTEGER;

UPDATE "Plan"
SET "maxProjects" = 20,
    "maxMembers" = 10,
    "maxDeploymentsPerMonth" = 100,
    "maxBuildMinutesPerMonth" = 300,
    "maxServers" = 2,
    "maxDatabases" = 1,
    "maxRedisInstances" = 1
WHERE code = 'alpha';

INSERT INTO "Plan" ("id", "code", "name", "priceMonthly", "currency", "status", "createdAt", "updatedAt")
VALUES
  ('plan_free', 'free', 'Free', 0, 'CNY', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan_pro', 'pro', 'Pro', 0, 'CNY', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan_team', 'team', 'Team', 0, 'CNY', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan_enterprise', 'enterprise', 'Enterprise', 0, 'CNY', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

ALTER TABLE "Subscription" ADD COLUMN "overrideSource" TEXT;

CREATE TABLE "WorkspaceUsageSnapshot" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "projectCount" INTEGER NOT NULL DEFAULT 0,
  "memberCount" INTEGER NOT NULL DEFAULT 0,
  "activeServiceCount" INTEGER NOT NULL DEFAULT 0,
  "deploymentCount" INTEGER NOT NULL DEFAULT 0,
  "successfulDeploymentCount" INTEGER NOT NULL DEFAULT 0,
  "failedDeploymentCount" INTEGER NOT NULL DEFAULT 0,
  "buildCount" INTEGER NOT NULL DEFAULT 0,
  "buildDurationSeconds" INTEGER,
  "bandwidthBytes" INTEGER,
  "storageBytes" INTEGER,
  "serverCount" INTEGER NOT NULL DEFAULT 0,
  "databaseCount" INTEGER NOT NULL DEFAULT 0,
  "redisCount" INTEGER NOT NULL DEFAULT 0,
  "estimatedCloudCost" INTEGER,
  "estimated" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceUsageSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkspaceUsageSnapshot_workspaceId_periodStart_key" ON "WorkspaceUsageSnapshot"("workspaceId", "periodStart");
CREATE INDEX "WorkspaceUsageSnapshot_workspaceId_createdAt_idx" ON "WorkspaceUsageSnapshot"("workspaceId", "createdAt");
ALTER TABLE "WorkspaceUsageSnapshot" ADD CONSTRAINT "WorkspaceUsageSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
