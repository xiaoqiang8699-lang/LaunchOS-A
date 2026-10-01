-- CreateTable
CREATE TABLE "ProjectAnalysis" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryPath" TEXT NOT NULL,
    "framework" TEXT NOT NULL,
    "packageManager" TEXT,
    "buildCommand" TEXT,
    "startCommand" TEXT,
    "port" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectAnalysis_projectId_createdAt_idx" ON "ProjectAnalysis"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProjectAnalysis" ADD CONSTRAINT "ProjectAnalysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
