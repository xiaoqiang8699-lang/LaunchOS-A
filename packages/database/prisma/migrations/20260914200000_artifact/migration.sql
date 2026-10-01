-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('BUILD_OUTPUT', 'DOCKER_IMAGE', 'PACKAGE');

-- CreateEnum
CREATE TYPE "ArtifactStatus" AS ENUM ('CREATED', 'UPLOADING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "type" "ArtifactType" NOT NULL,
    "storagePath" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'CREATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Artifact_deploymentId_createdAt_idx" ON "Artifact"("deploymentId", "createdAt");

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
