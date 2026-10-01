ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'TRIALING';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'CANCEL_AT_PERIOD_END';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

ALTER TABLE "Plan" ADD COLUMN "description" TEXT;
ALTER TABLE "Plan" ADD COLUMN "featuresJson" JSONB NOT NULL DEFAULT '{}';

UPDATE "Plan"
SET "description" = '适合开始使用',
    "priceMonthly" = 0,
    "maxProjects" = 5,
    "maxMembers" = 5,
    "maxDeploymentsPerMonth" = 100,
    "maxBuildMinutesPerMonth" = 300,
    "maxServers" = 1,
    "maxDatabases" = 1,
    "maxRedisInstances" = 1,
    "featuresJson" = '{"customDomain":false,"priorityBuild":false,"teamMembers":false,"advancedLogs":false,"privateNetworking":false,"supportLevel":"community"}'::jsonb
WHERE code = 'free';

UPDATE "Plan"
SET "description" = '更多应用和构建额度',
    "priceMonthly" = 49,
    "maxProjects" = 20,
    "maxMembers" = 10,
    "maxDeploymentsPerMonth" = 500,
    "maxBuildMinutesPerMonth" = 2000,
    "maxServers" = 3,
    "maxDatabases" = 2,
    "maxRedisInstances" = 2,
    "featuresJson" = '{"customDomain":true,"priorityBuild":false,"teamMembers":true,"advancedLogs":true,"privateNetworking":false,"supportLevel":"standard"}'::jsonb
WHERE code = 'pro';

UPDATE "Plan"
SET "description" = '适合协作团队',
    "priceMonthly" = 199,
    "maxProjects" = 50,
    "maxMembers" = 25,
    "maxDeploymentsPerMonth" = 2000,
    "maxBuildMinutesPerMonth" = 8000,
    "maxServers" = 10,
    "maxDatabases" = 5,
    "maxRedisInstances" = 5,
    "featuresJson" = '{"customDomain":true,"priorityBuild":true,"teamMembers":true,"advancedLogs":true,"privateNetworking":false,"supportLevel":"priority"}'::jsonb
WHERE code = 'team';

UPDATE "Plan"
SET "description" = '按需报价，额度不限',
    "priceMonthly" = 0,
    "maxProjects" = NULL,
    "maxMembers" = NULL,
    "maxDeploymentsPerMonth" = NULL,
    "maxBuildMinutesPerMonth" = NULL,
    "maxServers" = NULL,
    "maxDatabases" = NULL,
    "maxRedisInstances" = NULL,
    "featuresJson" = '{"customDomain":true,"priorityBuild":true,"teamMembers":true,"advancedLogs":true,"privateNetworking":true,"supportLevel":"enterprise"}'::jsonb
WHERE code = 'enterprise';

ALTER TABLE "Subscription" ADD COLUMN "overrideReason" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "overrideById" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "overriddenAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "quotaExceeded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_overrideById_fkey" FOREIGN KEY ("overrideById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Deployment" ADD COLUMN "usageClass" TEXT NOT NULL DEFAULT 'REAL_EXECUTION';
