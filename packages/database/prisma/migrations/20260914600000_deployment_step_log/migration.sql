-- CreateTable
CREATE TABLE "DeploymentStepLog" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "stdout" TEXT NOT NULL DEFAULT '',
    "stderr" TEXT NOT NULL DEFAULT '',
    "exitCode" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentStepLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeploymentStepLog_stepId_createdAt_idx" ON "DeploymentStepLog"("stepId", "createdAt");

-- CreateIndex
CREATE INDEX "DeploymentStepLog_deploymentId_createdAt_idx" ON "DeploymentStepLog"("deploymentId", "createdAt");

-- AddForeignKey
ALTER TABLE "DeploymentStepLog" ADD CONSTRAINT "DeploymentStepLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentStepLog" ADD CONSTRAINT "DeploymentStepLog_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "DeploymentStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
