-- CreateEnum
CREATE TYPE "RuntimeConfigInjectionPhase" AS ENUM ('BUILD', 'RUNTIME', 'BOTH');

-- AlterTable DeployableUnit
ALTER TABLE "DeployableUnit" ADD COLUMN "configRevision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable RuntimeConfigRequirement
ALTER TABLE "RuntimeConfigRequirement" ADD COLUMN "injectionPhase" "RuntimeConfigInjectionPhase" NOT NULL DEFAULT 'RUNTIME';

-- AlterTable Deployment
ALTER TABLE "Deployment" ADD COLUMN "configRevision" INTEGER,
ADD COLUMN "configFingerprint" TEXT,
ADD COLUMN "configKeys" JSONB;

-- AlterTable ApplicationVersion
ALTER TABLE "ApplicationVersion" ADD COLUMN "configRevision" INTEGER,
ADD COLUMN "configFingerprint" TEXT,
ADD COLUMN "configKeys" JSONB;

-- AlterTable ServiceInstance
ALTER TABLE "ServiceInstance" ADD COLUMN "configRevision" INTEGER,
ADD COLUMN "configFingerprint" TEXT,
ADD COLUMN "configKeys" JSONB;
