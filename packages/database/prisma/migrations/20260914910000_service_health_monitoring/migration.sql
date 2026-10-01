-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('HEALTHY', 'UNHEALTHY', 'UNKNOWN');

-- AlterTable
ALTER TABLE "ServiceInstance"
ADD COLUMN "healthStatus" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "lastHealthCheckAt" TIMESTAMP(3),
ADD COLUMN "responseTimeMs" INTEGER,
ADD COLUMN "healthMessage" TEXT;

-- CreateTable
CREATE TABLE "ServiceHealthCheck" (
    "id" TEXT NOT NULL,
    "serviceInstanceId" TEXT NOT NULL,
    "status" "HealthStatus" NOT NULL,
    "responseTimeMs" INTEGER,
    "statusCode" INTEGER,
    "message" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceHealthCheck_serviceInstanceId_checkedAt_idx"
ON "ServiceHealthCheck"("serviceInstanceId", "checkedAt");

-- AddForeignKey
ALTER TABLE "ServiceHealthCheck"
ADD CONSTRAINT "ServiceHealthCheck_serviceInstanceId_fkey"
FOREIGN KEY ("serviceInstanceId") REFERENCES "ServiceInstance"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
