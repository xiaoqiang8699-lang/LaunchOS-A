-- CreateTable
CREATE TABLE "ServerInstance" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "credentialEncrypted" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'CUSTOM',
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "dockerStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServerInstance_workspaceId_createdAt_idx" ON "ServerInstance"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "ServerInstance" ADD CONSTRAINT "ServerInstance_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
