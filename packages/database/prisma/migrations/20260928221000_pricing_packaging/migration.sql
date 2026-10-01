CREATE TYPE "UpgradeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED');

ALTER TABLE "Plan" ADD COLUMN "priceYearly" INTEGER;
ALTER TABLE "Plan" ADD COLUMN "contactSales" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Plan" ADD COLUMN "billingIntervalOptions" JSONB NOT NULL DEFAULT '["monthly","yearly"]';
ALTER TABLE "Plan" ADD COLUMN "recommendationLabel" TEXT;
ALTER TABLE "Plan" ADD COLUMN "marketingDescription" TEXT;
ALTER TABLE "Plan" ADD COLUMN "audience" TEXT;
ALTER TABLE "Plan" ADD COLUMN "highlighted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Plan" ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PlanVersion" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "priceMonthly" INTEGER NOT NULL,
  "priceYearly" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "limitsJson" JSONB NOT NULL,
  "featuresJson" JSONB NOT NULL DEFAULT '{}',
  "grandfathered" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlanVersion_planId_version_key" ON "PlanVersion"("planId", "version");
CREATE INDEX "PlanVersion_planId_effectiveTo_idx" ON "PlanVersion"("planId", "effectiveTo");
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "PlanVersion" (
  "id", "planId", "version", "effectiveFrom", "priceMonthly", "priceYearly", "currency", "limitsJson", "featuresJson", "grandfathered"
)
SELECT
  'pv1_' || "id",
  "id",
  1,
  "createdAt",
  "priceMonthly",
  NULL,
  "currency",
  jsonb_build_object(
    'maxProjects', "maxProjects",
    'maxMembers', "maxMembers",
    'maxDeploymentsPerMonth', "maxDeploymentsPerMonth",
    'maxBuildMinutesPerMonth', "maxBuildMinutesPerMonth",
    'maxServers', "maxServers",
    'maxDatabases', "maxDatabases",
    'maxRedisInstances', "maxRedisInstances"
  ),
  COALESCE("featuresJson", '{}'::jsonb),
  true
FROM "Plan";

ALTER TABLE "Subscription" ADD COLUMN "planVersionId" TEXT;
UPDATE "Subscription" SET "planVersionId" = 'pv1_' || "planId";
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice" ADD COLUMN "planVersionId" TEXT;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "PlanVersion" SET "effectiveTo" = CURRENT_TIMESTAMP
WHERE "planId" IN (SELECT "id" FROM "Plan" WHERE "code" IN ('free', 'pro', 'team', 'enterprise'));

UPDATE "Plan" SET
  "priceMonthly" = 0,
  "priceYearly" = 0,
  "contactSales" = false,
  "displayOrder" = 10,
  "audience" = '适合第一次体验 LaunchOS 的个人用户',
  "marketingDescription" = '首次体验和轻量项目',
  "maxProjects" = 1,
  "maxMembers" = 1,
  "maxDeploymentsPerMonth" = 10,
  "maxBuildMinutesPerMonth" = 60,
  "maxServers" = 1,
  "maxDatabases" = 0,
  "maxRedisInstances" = 0,
  "featuresJson" = '{"customDomain":false,"priorityBuild":false,"advancedLogs":false,"teamPermissions":false,"auditLog":false,"privateNetworking":false,"sso":false,"supportLevel":"community"}'::jsonb
WHERE "code" = 'free';

UPDATE "Plan" SET
  "priceMonthly" = 99,
  "priceYearly" = 990,
  "contactSales" = false,
  "displayOrder" = 20,
  "audience" = '适合独立开发者和小型线上项目',
  "marketingDescription" = '个人开发者和小型项目',
  "maxProjects" = 5,
  "maxMembers" = 3,
  "maxDeploymentsPerMonth" = 100,
  "maxBuildMinutesPerMonth" = 500,
  "maxServers" = 3,
  "maxDatabases" = 2,
  "maxRedisInstances" = 2,
  "featuresJson" = '{"customDomain":true,"priorityBuild":true,"advancedLogs":true,"teamPermissions":false,"auditLog":false,"privateNetworking":false,"sso":false,"supportLevel":"standard"}'::jsonb
WHERE "code" = 'pro';

UPDATE "Plan" SET
  "priceMonthly" = 299,
  "priceYearly" = 2990,
  "contactSales" = false,
  "displayOrder" = 30,
  "audience" = '适合多人协作和商业项目',
  "marketingDescription" = '小团队和商业项目',
  "maxProjects" = 20,
  "maxMembers" = 10,
  "maxDeploymentsPerMonth" = 500,
  "maxBuildMinutesPerMonth" = 3000,
  "maxServers" = 10,
  "maxDatabases" = 10,
  "maxRedisInstances" = 10,
  "featuresJson" = '{"customDomain":true,"priorityBuild":true,"advancedLogs":true,"teamPermissions":true,"auditLog":true,"privateNetworking":false,"sso":false,"supportLevel":"priority"}'::jsonb
WHERE "code" = 'team';

UPDATE "Plan" SET
  "priceMonthly" = 0,
  "priceYearly" = NULL,
  "contactSales" = true,
  "displayOrder" = 40,
  "audience" = '适合需要高级权限、安全和定制能力的企业',
  "marketingDescription" = '企业客户和定制需求',
  "maxProjects" = NULL,
  "maxMembers" = NULL,
  "maxDeploymentsPerMonth" = NULL,
  "maxBuildMinutesPerMonth" = NULL,
  "maxServers" = NULL,
  "maxDatabases" = NULL,
  "maxRedisInstances" = NULL,
  "featuresJson" = '{"customDomain":true,"priorityBuild":true,"advancedLogs":true,"teamPermissions":true,"auditLog":true,"privateNetworking":true,"sso":true,"supportLevel":"dedicated"}'::jsonb
WHERE "code" = 'enterprise';

INSERT INTO "PlanVersion" (
  "id", "planId", "version", "effectiveFrom", "priceMonthly", "priceYearly", "currency", "limitsJson", "featuresJson", "grandfathered"
)
SELECT
  'pv2_' || "id",
  "id",
  2,
  CURRENT_TIMESTAMP,
  "priceMonthly",
  "priceYearly",
  "currency",
  jsonb_build_object(
    'maxProjects', "maxProjects",
    'maxMembers', "maxMembers",
    'maxDeploymentsPerMonth', "maxDeploymentsPerMonth",
    'maxBuildMinutesPerMonth', "maxBuildMinutesPerMonth",
    'maxServers', "maxServers",
    'maxDatabases', "maxDatabases",
    'maxRedisInstances', "maxRedisInstances"
  ),
  COALESCE("featuresJson", '{}'::jsonb),
  false
FROM "Plan"
WHERE "code" IN ('free', 'pro', 'team', 'enterprise');

CREATE TABLE "UpgradeRequest" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "fromPlanId" TEXT NOT NULL,
  "requestedPlanId" TEXT NOT NULL,
  "fromSource" TEXT,
  "reason" TEXT NOT NULL,
  "status" "UpgradeRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "handledById" TEXT,
  "handledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UpgradeRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UpgradeRequest_workspaceId_status_idx" ON "UpgradeRequest"("workspaceId", "status");
CREATE INDEX "UpgradeRequest_status_createdAt_idx" ON "UpgradeRequest"("status", "createdAt");
ALTER TABLE "UpgradeRequest" ADD CONSTRAINT "UpgradeRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UpgradeRequest" ADD CONSTRAINT "UpgradeRequest_fromPlanId_fkey" FOREIGN KEY ("fromPlanId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UpgradeRequest" ADD CONSTRAINT "UpgradeRequest_requestedPlanId_fkey" FOREIGN KEY ("requestedPlanId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UpgradeRequest" ADD CONSTRAINT "UpgradeRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UpgradeRequest" ADD CONSTRAINT "UpgradeRequest_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
