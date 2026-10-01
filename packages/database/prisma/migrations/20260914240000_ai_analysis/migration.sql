-- CreateTable
CREATE TABLE "DeploymentPlan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtime" TEXT NOT NULL,
    "buildCommand" TEXT NOT NULL,
    "startCommand" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAnalysis" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeploymentPlan_projectId_createdAt_idx" ON "DeploymentPlan"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_projectId_createdAt_idx" ON "AiAnalysis"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "DeploymentPlan" ADD CONSTRAINT "DeploymentPlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAnalysis" ADD CONSTRAINT "AiAnalysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
