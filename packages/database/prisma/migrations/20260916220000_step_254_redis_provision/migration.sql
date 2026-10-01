-- AlterEnum
ALTER TYPE "CloudResourceType" ADD VALUE 'CACHE';

-- AlterEnum
ALTER TYPE "RedisConnectionStatus" ADD VALUE 'UNAVAILABLE';

-- AlterTable
ALTER TABLE "RedisConnection" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "RedisConnection" ADD COLUMN "cloudResourceId" TEXT;

-- CreateIndex
CREATE INDEX "RedisConnection_cloudResourceId_idx" ON "RedisConnection"("cloudResourceId");

-- AddForeignKey
ALTER TABLE "RedisConnection" ADD CONSTRAINT "RedisConnection_cloudResourceId_fkey" FOREIGN KEY ("cloudResourceId") REFERENCES "CloudResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
