-- CreateEnum
CREATE TYPE "ApplicationDnsStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED');

-- AlterTable
ALTER TABLE "ApplicationDomain" ADD COLUMN "dnsStatus" "ApplicationDnsStatus" NOT NULL DEFAULT 'PENDING';
