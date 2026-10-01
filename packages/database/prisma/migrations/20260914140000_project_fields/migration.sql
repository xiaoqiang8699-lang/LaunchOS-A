-- AlterTable
ALTER TABLE "Project" ADD COLUMN "framework" TEXT;
ALTER TABLE "Project" ADD COLUMN "repositoryUrl" TEXT;
ALTER TABLE "Project" ADD COLUMN "defaultBranch" TEXT;

-- AlterTable
ALTER TABLE "ProjectEnvironment" ADD COLUMN "variables" JSONB NOT NULL DEFAULT '{}';
