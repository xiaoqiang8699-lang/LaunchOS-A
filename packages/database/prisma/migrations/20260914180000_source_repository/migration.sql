-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('GITHUB', 'GITLAB', 'UPLOAD');

-- CreateTable
CREATE TABLE "SourceRepository" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "SourceType" NOT NULL,
    "url" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceRepository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourceRepository_projectId_createdAt_idx" ON "SourceRepository"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "SourceRepository" ADD CONSTRAINT "SourceRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
