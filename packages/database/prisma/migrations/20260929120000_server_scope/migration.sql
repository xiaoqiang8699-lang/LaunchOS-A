-- Managed Hosting v1: distinguish platform nodes from workspace-owned servers.
CREATE TYPE "ServerScope" AS ENUM ('WORKSPACE_OWNED', 'PLATFORM_MANAGED');

ALTER TABLE "ServerInstance" ADD COLUMN "scope" "ServerScope" NOT NULL DEFAULT 'WORKSPACE_OWNED';

ALTER TABLE "ServerInstance" ALTER COLUMN "workspaceId" DROP NOT NULL;

CREATE INDEX "ServerInstance_scope_status_idx" ON "ServerInstance"("scope", "status");
