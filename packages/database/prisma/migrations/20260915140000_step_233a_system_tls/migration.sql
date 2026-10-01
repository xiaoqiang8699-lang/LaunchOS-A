-- AlterTable
ALTER TABLE "SystemDomainConfig" ADD COLUMN     "tlsStatus" "ApplicationSslStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "tlsCertificateDomain" TEXT,
ADD COLUMN     "tlsIssuer" TEXT,
ADD COLUMN     "tlsExpiresAt" TIMESTAMP(3),
ADD COLUMN     "tlsLastVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "tlsManager" TEXT,
ADD COLUMN     "tlsCertPathHint" TEXT;
