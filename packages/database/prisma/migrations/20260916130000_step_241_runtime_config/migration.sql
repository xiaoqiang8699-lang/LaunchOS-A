-- Step 24.1: Runtime config requirements + encrypted values (unit-scoped)

CREATE TYPE "RuntimeConfigSource" AS ENUM ('ENV_EXAMPLE', 'CODE_REFERENCE', 'FRAMEWORK', 'MANUAL');
CREATE TYPE "RuntimeConfigRequirementStatus" AS ENUM ('DETECTED', 'CONFIGURED', 'IGNORED');
CREATE TYPE "RuntimeConfigConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

CREATE TABLE "RuntimeConfigRequirement" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "deployableUnitId" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'UNIT',
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "required" BOOLEAN NOT NULL DEFAULT false,
  "sensitive" BOOLEAN NOT NULL DEFAULT false,
  "managedByLaunchOS" BOOLEAN NOT NULL DEFAULT false,
  "publicSafe" BOOLEAN NOT NULL DEFAULT false,
  "source" "RuntimeConfigSource" NOT NULL,
  "sourceLocation" TEXT,
  "defaultValue" TEXT,
  "confidence" "RuntimeConfigConfidence" NOT NULL DEFAULT 'MEDIUM',
  "status" "RuntimeConfigRequirementStatus" NOT NULL DEFAULT 'DETECTED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RuntimeConfigRequirement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RuntimeConfigRequirement_deployableUnitId_key_key"
  ON "RuntimeConfigRequirement"("deployableUnitId", "key");
CREATE INDEX "RuntimeConfigRequirement_projectId_deployableUnitId_idx"
  ON "RuntimeConfigRequirement"("projectId", "deployableUnitId");

CREATE TABLE "RuntimeConfigValue" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "deployableUnitId" TEXT NOT NULL,
  "requirementId" TEXT,
  "scope" TEXT NOT NULL DEFAULT 'UNIT',
  "key" TEXT NOT NULL,
  "valueEncrypted" TEXT NOT NULL,
  "isSensitive" BOOLEAN NOT NULL DEFAULT false,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RuntimeConfigValue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RuntimeConfigValue_deployableUnitId_key_key"
  ON "RuntimeConfigValue"("deployableUnitId", "key");
CREATE INDEX "RuntimeConfigValue_projectId_deployableUnitId_idx"
  ON "RuntimeConfigValue"("projectId", "deployableUnitId");
CREATE INDEX "RuntimeConfigValue_requirementId_idx"
  ON "RuntimeConfigValue"("requirementId");

ALTER TABLE "RuntimeConfigRequirement"
  ADD CONSTRAINT "RuntimeConfigRequirement_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RuntimeConfigRequirement"
  ADD CONSTRAINT "RuntimeConfigRequirement_deployableUnitId_fkey"
  FOREIGN KEY ("deployableUnitId") REFERENCES "DeployableUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RuntimeConfigValue"
  ADD CONSTRAINT "RuntimeConfigValue_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RuntimeConfigValue"
  ADD CONSTRAINT "RuntimeConfigValue_deployableUnitId_fkey"
  FOREIGN KEY ("deployableUnitId") REFERENCES "DeployableUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RuntimeConfigValue"
  ADD CONSTRAINT "RuntimeConfigValue_requirementId_fkey"
  FOREIGN KEY ("requirementId") REFERENCES "RuntimeConfigRequirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
