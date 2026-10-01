-- External Alpha user-test sessions. Analysis only; no deploy model changes.

CREATE TYPE "AlphaSessionStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'ABANDONED');
CREATE TYPE "AlphaProjectType" AS ENUM ('WEB', 'API', 'WEB_API');
CREATE TYPE "AlphaFrameworkTag" AS ENUM ('VITE', 'NEXTJS', 'NODE', 'OTHER_SUPPORTED');
CREATE TYPE "AlphaDependencyTag" AS ENUM ('POSTGRESQL', 'REDIS', 'NONE');
CREATE TYPE "AlphaHealthMark" AS ENUM ('HEALTHY', 'UNHEALTHY', 'UNKNOWN');
CREATE TYPE "AlphaIssueSeverity" AS ENUM ('P0', 'P1', 'P2', 'P3', 'P4');

CREATE TABLE "AlphaTestSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT,
  "launchRunId" TEXT,
  "sessionStatus" "AlphaSessionStatus" NOT NULL DEFAULT 'PLANNED',
  "projectType" "AlphaProjectType",
  "framework" "AlphaFrameworkTag",
  "dependencies" "AlphaDependencyTag",
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "launchSucceeded" BOOLEAN,
  "totalDurationMs" INTEGER,
  "blockedStage" TEXT,
  "blockedStep" TEXT,
  "manualInterventionCount" INTEGER NOT NULL DEFAULT 0,
  "primaryFailureCode" TEXT,
  "publicUrl" TEXT,
  "health10m" "AlphaHealthMark" NOT NULL DEFAULT 'UNKNOWN',
  "health1h" "AlphaHealthMark" NOT NULL DEFAULT 'UNKNOWN',
  "health24h" "AlphaHealthMark" NOT NULL DEFAULT 'UNKNOWN',
  "sessionStartedAt" TIMESTAMP(3),
  "planCreatedAt" TIMESTAMP(3),
  "launchStartedAt" TIMESTAMP(3),
  "launchCompletedAt" TIMESTAMP(3),
  "publicVerifiedAt" TIMESTAMP(3),
  "knewNextStep" INTEGER,
  "billingClear" INTEGER,
  "failureUnderstandable" INTEGER,
  "neededHelp" INTEGER,
  "wouldContinue" INTEGER,
  "freeFeedback" TEXT,
  "feedbackSubmittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AlphaTestSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AlphaIntervention" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actionTaken" TEXT NOT NULL,
  "resolved" BOOLEAN NOT NULL DEFAULT false,
  "severity" "AlphaIssueSeverity",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlphaIntervention_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductEvent" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "userId" TEXT,
  "projectId" TEXT,
  "sessionId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AlphaTestSession_userId_createdAt_idx" ON "AlphaTestSession"("userId", "createdAt");
CREATE INDEX "AlphaTestSession_projectId_sessionStatus_idx" ON "AlphaTestSession"("projectId", "sessionStatus");
CREATE INDEX "AlphaTestSession_launchRunId_idx" ON "AlphaTestSession"("launchRunId");
CREATE INDEX "AlphaIntervention_sessionId_createdAt_idx" ON "AlphaIntervention"("sessionId", "createdAt");
CREATE INDEX "ProductEvent_name_createdAt_idx" ON "ProductEvent"("name", "createdAt");
CREATE INDEX "ProductEvent_sessionId_createdAt_idx" ON "ProductEvent"("sessionId", "createdAt");

ALTER TABLE "AlphaTestSession" ADD CONSTRAINT "AlphaTestSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlphaTestSession" ADD CONSTRAINT "AlphaTestSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AlphaTestSession" ADD CONSTRAINT "AlphaTestSession_launchRunId_fkey" FOREIGN KEY ("launchRunId") REFERENCES "LaunchRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AlphaIntervention" ADD CONSTRAINT "AlphaIntervention_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AlphaTestSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AlphaTestSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
