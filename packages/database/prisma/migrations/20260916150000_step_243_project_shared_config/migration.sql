-- Step 24.3: Project shared runtime config + unit inheritance

CREATE TYPE "RuntimeConfigScopeType" AS ENUM ('PROJECT', 'UNIT');

ALTER TABLE "Project" ADD COLUMN "sharedConfigRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "RuntimeConfigValue" ADD COLUMN "scopeType" "RuntimeConfigScopeType";
ALTER TABLE "RuntimeConfigValue" ADD COLUMN "scopeId" TEXT;

UPDATE "RuntimeConfigValue"
SET "scopeType" = 'UNIT', "scopeId" = "deployableUnitId"
WHERE "scopeType" IS NULL;

ALTER TABLE "RuntimeConfigValue" ALTER COLUMN "scopeType" SET NOT NULL;
ALTER TABLE "RuntimeConfigValue" ALTER COLUMN "scopeType" SET DEFAULT 'UNIT';
ALTER TABLE "RuntimeConfigValue" ALTER COLUMN "scopeId" SET NOT NULL;

DROP INDEX IF EXISTS "RuntimeConfigValue_deployableUnitId_key_key";

CREATE UNIQUE INDEX "RuntimeConfigValue_scopeType_scopeId_key_key"
  ON "RuntimeConfigValue"("scopeType", "scopeId", "key");

ALTER TABLE "RuntimeConfigValue" ALTER COLUMN "deployableUnitId" DROP NOT NULL;

CREATE INDEX "RuntimeConfigValue_projectId_scopeType_idx"
  ON "RuntimeConfigValue"("projectId", "scopeType");
