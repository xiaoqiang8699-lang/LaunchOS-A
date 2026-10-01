-- AlterTable
ALTER TABLE "DeploymentStep" ADD COLUMN "command" TEXT;
ALTER TABLE "DeploymentStep" ADD COLUMN "exitCode" INTEGER;
ALTER TABLE "DeploymentStep" ADD COLUMN "duration" INTEGER;
