-- Step 29 Phase 1: GatewayRoute access-entry model (no Domain/Deployment scatter).

CREATE TYPE "GatewayRouteStatus" AS ENUM ('PENDING', 'CONFIGURING', 'ACTIVE', 'FAILED', 'DISABLED');

CREATE TABLE "GatewayRoute" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "serviceInstanceId" TEXT,
    "serverInstanceId" TEXT,
    "hostname" TEXT NOT NULL,
    "scheme" TEXT NOT NULL DEFAULT 'https',
    "targetHost" TEXT NOT NULL DEFAULT '127.0.0.1',
    "targetPort" INTEGER NOT NULL,
    "healthPath" TEXT NOT NULL DEFAULT '/',
    "status" "GatewayRouteStatus" NOT NULL DEFAULT 'PENDING',
    "certificateId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayRoute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GatewayRoute_hostname_key" ON "GatewayRoute"("hostname");
CREATE INDEX "GatewayRoute_projectId_unitId_idx" ON "GatewayRoute"("projectId", "unitId");
CREATE INDEX "GatewayRoute_projectId_status_idx" ON "GatewayRoute"("projectId", "status");
CREATE INDEX "GatewayRoute_serverInstanceId_idx" ON "GatewayRoute"("serverInstanceId");
CREATE INDEX "GatewayRoute_serviceInstanceId_idx" ON "GatewayRoute"("serviceInstanceId");

ALTER TABLE "GatewayRoute" ADD CONSTRAINT "GatewayRoute_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GatewayRoute" ADD CONSTRAINT "GatewayRoute_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "DeployableUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GatewayRoute" ADD CONSTRAINT "GatewayRoute_serviceInstanceId_fkey" FOREIGN KEY ("serviceInstanceId") REFERENCES "ServiceInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GatewayRoute" ADD CONSTRAINT "GatewayRoute_serverInstanceId_fkey" FOREIGN KEY ("serverInstanceId") REFERENCES "ServerInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
