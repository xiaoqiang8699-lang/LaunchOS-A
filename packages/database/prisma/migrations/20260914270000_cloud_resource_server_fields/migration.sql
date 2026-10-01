-- AlterTable
ALTER TABLE "CloudResource" ADD COLUMN "projectId" TEXT;
ALTER TABLE "CloudResource" ADD COLUMN "providerResourceId" TEXT;
ALTER TABLE "CloudResource" ADD COLUMN "publicIp" TEXT;
ALTER TABLE "CloudResource" ADD COLUMN "instanceType" TEXT;

UPDATE "CloudResource"
SET "providerResourceId" = "externalId"
WHERE "providerResourceId" IS NULL;

-- CreateIndex
CREATE INDEX "CloudResource_projectId_createdAt_idx" ON "CloudResource"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "CloudResource" ADD CONSTRAINT "CloudResource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
