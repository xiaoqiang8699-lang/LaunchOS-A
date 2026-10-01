-- Step 25.2: Existing Redis service connection

CREATE TYPE "RedisConnectionStatus" AS ENUM ('UNTESTED', 'CONNECTED', 'FAILED');
CREATE TYPE "RedisTlsMode" AS ENUM ('AUTO', 'REQUIRE', 'DISABLE');

CREATE TABLE "RedisConnection" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "RedisConnectionStatus" NOT NULL DEFAULT 'UNTESTED',
  "host" TEXT NOT NULL,
  "port" INTEGER NOT NULL DEFAULT 6379,
  "usernameEncrypted" TEXT,
  "passwordEncrypted" TEXT,
  "databaseIndex" INTEGER NOT NULL DEFAULT 0,
  "tlsMode" "RedisTlsMode" NOT NULL DEFAULT 'AUTO',
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "lastTestedAt" TIMESTAMP(3),
  "lastTestStatus" "DatabaseTestStatus",
  "lastTestErrorCode" TEXT,
  "lastTestLatencyMs" INTEGER,
  "lastTestLocation" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RedisConnection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RedisConnection_projectId_createdAt_idx" ON "RedisConnection"("projectId", "createdAt");
CREATE INDEX "RedisConnection_workspaceId_projectId_idx" ON "RedisConnection"("workspaceId", "projectId");

ALTER TABLE "RedisConnection"
  ADD CONSTRAINT "RedisConnection_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RedisConnection"
  ADD CONSTRAINT "RedisConnection_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RedisConnectionUnit" (
  "id" TEXT NOT NULL,
  "redisConnectionId" TEXT NOT NULL,
  "deployableUnitId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RedisConnectionUnit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RedisConnectionUnit_redisConnectionId_deployableUnitId_key"
  ON "RedisConnectionUnit"("redisConnectionId", "deployableUnitId");
CREATE INDEX "RedisConnectionUnit_deployableUnitId_idx"
  ON "RedisConnectionUnit"("deployableUnitId");

ALTER TABLE "RedisConnectionUnit"
  ADD CONSTRAINT "RedisConnectionUnit_redisConnectionId_fkey"
  FOREIGN KEY ("redisConnectionId") REFERENCES "RedisConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RedisConnectionUnit"
  ADD CONSTRAINT "RedisConnectionUnit_deployableUnitId_fkey"
  FOREIGN KEY ("deployableUnitId") REFERENCES "DeployableUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
