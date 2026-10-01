-- AlterTable
ALTER TABLE "ServiceInstance" ADD COLUMN "runtimeMode" TEXT NOT NULL DEFAULT 'mock';
ALTER TABLE "ServiceInstance" ADD COLUMN "imageTag" TEXT;
ALTER TABLE "ServiceInstance" ADD COLUMN "imageId" TEXT;
