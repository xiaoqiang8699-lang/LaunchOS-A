-- CreateEnum
CREATE TYPE "RemoteDeploymentStatus" AS ENUM ('PENDING', 'CONNECTING', 'DEPLOYING', 'RUNNING', 'FAILED');

-- CreateTable
CREATE TABLE "RemoteDeployment" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "cloudResourceId" TEXT NOT NULL,
    "status" "RemoteDeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "logs" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RemoteDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemoteDeployment_deploymentId_startedAt_idx" ON "RemoteDeployment"("deploymentId", "startedAt");

-- CreateIndex
CREATE INDEX "RemoteDeployment_cloudResourceId_idx" ON "RemoteDeployment"("cloudResourceId");

-- AddForeignKey
ALTER TABLE "RemoteDeployment" ADD CONSTRAINT "RemoteDeployment_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteDeployment" ADD CONSTRAINT "RemoteDeployment_cloudResourceId_fkey" FOREIGN KEY ("cloudResourceId") REFERENCES "CloudResource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
