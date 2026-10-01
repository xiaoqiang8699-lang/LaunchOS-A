-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- AlterTable
ALTER TABLE "WorkspaceMember" ALTER COLUMN "role" TYPE "WorkspaceRole" USING ("role"::"WorkspaceRole");
