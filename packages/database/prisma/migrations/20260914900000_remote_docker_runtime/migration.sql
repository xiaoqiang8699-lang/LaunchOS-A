-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN "serverInstanceId" TEXT;

-- AlterTable
ALTER TABLE "ServiceInstance" ADD COLUMN "serverInstanceId" TEXT;
ALTER TABLE "ServiceInstance" ADD COLUMN "externalPort" INTEGER;
ALTER TABLE "ServiceInstance" ADD COLUMN "internalPort" INTEGER;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_serverInstanceId_fkey" FOREIGN KEY ("serverInstanceId") REFERENCES "ServerInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceInstance" ADD CONSTRAINT "ServiceInstance_serverInstanceId_fkey" FOREIGN KEY ("serverInstanceId") REFERENCES "ServerInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
