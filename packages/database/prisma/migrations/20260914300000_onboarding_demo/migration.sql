-- AlterTable
ALTER TABLE "User" ADD COLUMN "hasCompletedOnboarding" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
