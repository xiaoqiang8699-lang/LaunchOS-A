-- Step 25.1: Existing PostgreSQL database connection

CREATE TYPE "DatabaseEngine" AS ENUM ('POSTGRESQL');
CREATE TYPE "DatabaseConnectionStatus" AS ENUM ('UNTESTED', 'CONNECTED', 'FAILED');
CREATE TYPE "DatabaseSslMode" AS ENUM ('AUTO', 'REQUIRE', 'DISABLE');
CREATE TYPE "DatabaseTestStatus" AS ENUM ('SUCCESS', 'FAILED');

ALTER TABLE "RuntimeConfigValue"
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "providerRef" TEXT;

CREATE INDEX "RuntimeConfigValue_provider_providerRef_idx"
  ON "RuntimeConfigValue"("provider", "providerRef");

CREATE TABLE "DatabaseConnection" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "engine" "DatabaseEngine" NOT NULL DEFAULT 'POSTGRESQL',
  "status" "DatabaseConnectionStatus" NOT NULL DEFAULT 'UNTESTED',
  "host" TEXT NOT NULL,
  "port" INTEGER NOT NULL DEFAULT 5432,
  "databaseName" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordEncrypted" TEXT NOT NULL,
  "sslMode" "DatabaseSslMode" NOT NULL DEFAULT 'AUTO',
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "lastTestedAt" TIMESTAMP(3),
  "lastTestStatus" "DatabaseTestStatus",
  "lastTestErrorCode" TEXT,
  "lastTestLatencyMs" INTEGER,
  "lastTestLocation" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DatabaseConnection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DatabaseConnection_projectId_createdAt_idx"
  ON "DatabaseConnection"("projectId", "createdAt");
CREATE INDEX "DatabaseConnection_workspaceId_projectId_idx"
  ON "DatabaseConnection"("workspaceId", "projectId");

ALTER TABLE "DatabaseConnection"
  ADD CONSTRAINT "DatabaseConnection_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DatabaseConnection"
  ADD CONSTRAINT "DatabaseConnection_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DatabaseConnectionUnit" (
  "id" TEXT NOT NULL,
  "databaseConnectionId" TEXT NOT NULL,
  "deployableUnitId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DatabaseConnectionUnit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DatabaseConnectionUnit_databaseConnectionId_deployableUnitId_key"
  ON "DatabaseConnectionUnit"("databaseConnectionId", "deployableUnitId");
CREATE INDEX "DatabaseConnectionUnit_deployableUnitId_idx"
  ON "DatabaseConnectionUnit"("deployableUnitId");

ALTER TABLE "DatabaseConnectionUnit"
  ADD CONSTRAINT "DatabaseConnectionUnit_databaseConnectionId_fkey"
  FOREIGN KEY ("databaseConnectionId") REFERENCES "DatabaseConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DatabaseConnectionUnit"
  ADD CONSTRAINT "DatabaseConnectionUnit_deployableUnitId_fkey"
  FOREIGN KEY ("deployableUnitId") REFERENCES "DeployableUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
