-- AlterTable
ALTER TABLE "ProductEvent" ADD COLUMN "workspaceId" TEXT;

-- CreateIndex
CREATE INDEX "ProductEvent_userId_createdAt_idx" ON "ProductEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductEvent_workspaceId_createdAt_idx" ON "ProductEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductEvent_projectId_createdAt_idx" ON "ProductEvent"("projectId", "createdAt");

-- CreateTable
CREATE TABLE "UserGrowthSnapshot" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "registeredUsers" INTEGER NOT NULL DEFAULT 0,
    "activeUsers" INTEGER NOT NULL DEFAULT 0,
    "newProjects" INTEGER NOT NULL DEFAULT 0,
    "deploySuccess" INTEGER NOT NULL DEFAULT 0,
    "paidUsers" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserGrowthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserGrowthSnapshot_date_key" ON "UserGrowthSnapshot"("date");

-- CreateIndex
CREATE INDEX "UserGrowthSnapshot_date_idx" ON "UserGrowthSnapshot"("date");
