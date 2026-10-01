CREATE TYPE "OnboardingStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

ALTER TABLE "User" ADD COLUMN "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "User" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "isInternal" BOOLEAN NOT NULL DEFAULT false;

UPDATE "User"
SET "onboardingStatus" = 'COMPLETED',
    "onboardingCompletedAt" = "updatedAt",
    "isInternal" = true
WHERE "hasCompletedOnboarding" = true;

UPDATE "User" AS u
SET "onboardingStatus" = 'COMPLETED',
    "onboardingCompletedAt" = COALESCE(u."onboardingCompletedAt", u."updatedAt")
WHERE u."onboardingStatus" = 'NOT_STARTED'
  AND EXISTS (
    SELECT 1
    FROM "WorkspaceMember" wm
    JOIN "Project" p ON p."workspaceId" = wm."workspaceId"
    WHERE wm."userId" = u.id
      AND p."isDemo" = false
      AND p."name" NOT IN ('示例应用', '体验应用')
  );
