-- Beta M6: entitlement override + usage ledger + PlanVersion v3 (prices unchanged)

CREATE TABLE IF NOT EXISTS "WorkspaceEntitlementOverride" (
  "id" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "entitlementsJson" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "actorId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceEntitlementOverride_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkspaceEntitlementOverride_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "WorkspaceEntitlementOverride_workspaceId_expiresAt_idx"
  ON "WorkspaceEntitlementOverride"("workspaceId", "expiresAt");
CREATE INDEX IF NOT EXISTS "WorkspaceEntitlementOverride_workspaceId_revokedAt_idx"
  ON "WorkspaceEntitlementOverride"("workspaceId", "revokedAt");

CREATE TABLE IF NOT EXISTS "UsageLedger" (
  "id" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "resourceType" TEXT,
  "resourceId" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "idempotencyKey" TEXT NOT NULL,
  "metadataSafe" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageLedger_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "UsageLedger_idempotencyKey_key" ON "UsageLedger"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "UsageLedger_workspaceId_eventType_createdAt_idx"
  ON "UsageLedger"("workspaceId", "eventType", "createdAt");
CREATE INDEX IF NOT EXISTS "UsageLedger_workspaceId_periodStart_idx"
  ON "UsageLedger"("workspaceId", "periodStart");
CREATE INDEX IF NOT EXISTS "UsageLedger_resourceId_idx" ON "UsageLedger"("resourceId");

-- Close open PlanVersions then insert M6 v3 (same prices; new entitlements).
UPDATE "PlanVersion" SET "effectiveTo" = CURRENT_TIMESTAMP
WHERE "effectiveTo" IS NULL
  AND "planId" IN (SELECT id FROM "Plan" WHERE code IN ('free','pro','team','enterprise'));

-- free v3
INSERT INTO "PlanVersion" (
  "id", "planId", "version", "effectiveFrom", "effectiveTo",
  "priceMonthly", "priceMonthlyCents", "priceYearly", "currency",
  "limitsJson", "featuresJson", "grandfathered", "createdAt"
)
SELECT
  'pv_m6_free_v3', p.id,
  COALESCE((SELECT MAX(v."version") FROM "PlanVersion" v WHERE v."planId" = p.id), 0) + 1,
  CURRENT_TIMESTAMP, NULL,
  0, NULL, 0, 'CNY',
  '{"maxProjects":1,"maxMembers":1,"maxWorkspaceMembers":1,"maxDeploymentsPerMonth":10,"maxMonthlyDeployments":10,"maxRetainedVersions":3,"logRetentionDays":1,"maxRunningApps":1,"maxBuildMinutesPerMonth":50,"maxServers":1,"maxDatabases":0,"maxRedisInstances":0}'::jsonb,
  '{"customDomain":false,"customDomainEnabled":false,"rollback":true,"rollbackEnabled":true,"runtimeConfig":true,"runtimeConfigEnabled":true,"supportLevel":"community"}'::jsonb,
  false, CURRENT_TIMESTAMP
FROM "Plan" p WHERE p.code = 'free'
ON CONFLICT DO NOTHING;

-- pro v3 — price stays 99 / 990
INSERT INTO "PlanVersion" (
  "id", "planId", "version", "effectiveFrom", "effectiveTo",
  "priceMonthly", "priceMonthlyCents", "priceYearly", "currency",
  "limitsJson", "featuresJson", "grandfathered", "createdAt"
)
SELECT
  'pv_m6_pro_v3', p.id,
  COALESCE((SELECT MAX(v."version") FROM "PlanVersion" v WHERE v."planId" = p.id), 0) + 1,
  CURRENT_TIMESTAMP, NULL,
  99, NULL, 990, 'CNY',
  '{"maxProjects":10,"maxMembers":1,"maxWorkspaceMembers":1,"maxDeploymentsPerMonth":100,"maxMonthlyDeployments":100,"maxRetainedVersions":20,"logRetentionDays":7,"maxRunningApps":5,"maxBuildMinutesPerMonth":500,"maxServers":10,"maxDatabases":2,"maxRedisInstances":2}'::jsonb,
  '{"customDomain":true,"customDomainEnabled":true,"rollback":true,"rollbackEnabled":true,"runtimeConfig":true,"runtimeConfigEnabled":true,"supportLevel":"standard"}'::jsonb,
  false, CURRENT_TIMESTAMP
FROM "Plan" p WHERE p.code = 'pro'
ON CONFLICT DO NOTHING;

-- team v3 — price stays 299 / 2990
INSERT INTO "PlanVersion" (
  "id", "planId", "version", "effectiveFrom", "effectiveTo",
  "priceMonthly", "priceMonthlyCents", "priceYearly", "currency",
  "limitsJson", "featuresJson", "grandfathered", "createdAt"
)
SELECT
  'pv_m6_team_v3', p.id,
  COALESCE((SELECT MAX(v."version") FROM "PlanVersion" v WHERE v."planId" = p.id), 0) + 1,
  CURRENT_TIMESTAMP, NULL,
  299, NULL, 2990, 'CNY',
  '{"maxProjects":30,"maxMembers":5,"maxWorkspaceMembers":5,"maxDeploymentsPerMonth":500,"maxMonthlyDeployments":500,"maxRetainedVersions":100,"logRetentionDays":30,"maxRunningApps":15,"maxBuildMinutesPerMonth":2500,"maxServers":30,"maxDatabases":10,"maxRedisInstances":10}'::jsonb,
  '{"customDomain":true,"customDomainEnabled":true,"rollback":true,"rollbackEnabled":true,"runtimeConfig":true,"runtimeConfigEnabled":true,"supportLevel":"priority","teamPermissions":true}'::jsonb,
  false, CURRENT_TIMESTAMP
FROM "Plan" p WHERE p.code = 'team'
ON CONFLICT DO NOTHING;

-- enterprise v3 — custom / unlimited
INSERT INTO "PlanVersion" (
  "id", "planId", "version", "effectiveFrom", "effectiveTo",
  "priceMonthly", "priceMonthlyCents", "priceYearly", "currency",
  "limitsJson", "featuresJson", "grandfathered", "createdAt"
)
SELECT
  'pv_m6_enterprise_v3', p.id,
  COALESCE((SELECT MAX(v."version") FROM "PlanVersion" v WHERE v."planId" = p.id), 0) + 1,
  CURRENT_TIMESTAMP, NULL,
  0, NULL, NULL, 'CNY',
  '{"maxProjects":null,"maxMembers":null,"maxWorkspaceMembers":null,"maxDeploymentsPerMonth":null,"maxMonthlyDeployments":null,"maxRetainedVersions":null,"logRetentionDays":null,"maxRunningApps":null,"maxBuildMinutesPerMonth":null,"maxServers":null,"maxDatabases":null,"maxRedisInstances":null}'::jsonb,
  '{"customDomain":true,"customDomainEnabled":true,"rollback":true,"rollbackEnabled":true,"runtimeConfig":true,"runtimeConfigEnabled":true,"supportLevel":"dedicated","sso":true,"auditLog":true}'::jsonb,
  false, CURRENT_TIMESTAMP
FROM "Plan" p WHERE p.code = 'enterprise'
ON CONFLICT DO NOTHING;

-- Sync Plan catalog columns to M6 (prices untouched)
UPDATE "Plan" SET
  "maxProjects" = 1,
  "maxMembers" = 1,
  "maxDeploymentsPerMonth" = 10,
  "maxBuildMinutesPerMonth" = 50,
  "maxServers" = 1,
  "maxDatabases" = 0,
  "maxRedisInstances" = 0,
  "featuresJson" = '{"customDomain":false,"customDomainEnabled":false,"rollback":true,"rollbackEnabled":true,"runtimeConfig":true,"runtimeConfigEnabled":true,"supportLevel":"community"}'::jsonb,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE code = 'free';

UPDATE "Plan" SET
  "maxProjects" = 10,
  "maxMembers" = 1,
  "maxDeploymentsPerMonth" = 100,
  "maxBuildMinutesPerMonth" = 500,
  "maxServers" = 10,
  "maxDatabases" = 2,
  "maxRedisInstances" = 2,
  "featuresJson" = '{"customDomain":true,"customDomainEnabled":true,"rollback":true,"rollbackEnabled":true,"runtimeConfig":true,"runtimeConfigEnabled":true,"supportLevel":"standard"}'::jsonb,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE code = 'pro' AND "priceMonthly" = 99;

UPDATE "Plan" SET
  "maxProjects" = 30,
  "maxMembers" = 5,
  "maxDeploymentsPerMonth" = 500,
  "maxBuildMinutesPerMonth" = 2500,
  "maxServers" = 30,
  "maxDatabases" = 10,
  "maxRedisInstances" = 10,
  "featuresJson" = '{"customDomain":true,"customDomainEnabled":true,"rollback":true,"rollbackEnabled":true,"runtimeConfig":true,"runtimeConfigEnabled":true,"supportLevel":"priority","teamPermissions":true}'::jsonb,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE code = 'team' AND "priceMonthly" = 299;

-- Mark older versions grandfathered
UPDATE "PlanVersion" SET "grandfathered" = true
WHERE "id" NOT IN ('pv_m6_free_v3','pv_m6_pro_v3','pv_m6_team_v3','pv_m6_enterprise_v3')
  AND "planId" IN (SELECT id FROM "Plan" WHERE code IN ('free','pro','team','enterprise'));
