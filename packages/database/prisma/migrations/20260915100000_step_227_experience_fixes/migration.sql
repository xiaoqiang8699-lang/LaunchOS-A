-- CreateEnum
CREATE TYPE "ApplicationPurpose" AS ENUM ('WEBSITE', 'APP_WEBSITE', 'API', 'ADMIN', 'OTHER');

-- CreateEnum
CREATE TYPE "RemoteUploadStatus" AS ENUM ('IDLE', 'PREPARING', 'UPLOADING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Project"
ADD COLUMN "applicationPurpose" "ApplicationPurpose" NOT NULL DEFAULT 'WEBSITE';

-- AlterTable
ALTER TABLE "Deployment"
ADD COLUMN "uploadStatus" "RemoteUploadStatus" NOT NULL DEFAULT 'IDLE',
ADD COLUMN "uploadError" TEXT,
ADD COLUMN "uploadStartedAt" TIMESTAMP(3),
ADD COLUMN "uploadFinishedAt" TIMESTAMP(3);
