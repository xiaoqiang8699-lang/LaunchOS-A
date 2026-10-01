-- Step 23.8: GitHub App provider connections + SourceRepository auth fields

CREATE TYPE "GitProvider" AS ENUM ('GITHUB');

CREATE TYPE "GitConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED', 'NEEDS_REAUTH');

CREATE TABLE "GitProviderConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "GitProvider" NOT NULL DEFAULT 'GITHUB',
    "installationId" TEXT NOT NULL,
    "providerAccountId" TEXT,
    "login" TEXT NOT NULL,
    "accountType" TEXT,
    "status" "GitConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "encryptedSecrets" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitProviderConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitProviderConnection_workspaceId_provider_installationId_key"
  ON "GitProviderConnection"("workspaceId", "provider", "installationId");

CREATE INDEX "GitProviderConnection_workspaceId_provider_status_idx"
  ON "GitProviderConnection"("workspaceId", "provider", "status");

CREATE INDEX "GitProviderConnection_userId_idx"
  ON "GitProviderConnection"("userId");

ALTER TABLE "GitProviderConnection"
  ADD CONSTRAINT "GitProviderConnection_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GitProviderConnection"
  ADD CONSTRAINT "GitProviderConnection_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SourceRepository"
  ADD COLUMN "connectionId" TEXT,
  ADD COLUMN "providerRepositoryId" TEXT,
  ADD COLUMN "fullName" TEXT,
  ADD COLUMN "isPrivate" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "authStatus" TEXT NOT NULL DEFAULT 'OK';

CREATE INDEX "SourceRepository_connectionId_idx" ON "SourceRepository"("connectionId");

ALTER TABLE "SourceRepository"
  ADD CONSTRAINT "SourceRepository_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "GitProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
