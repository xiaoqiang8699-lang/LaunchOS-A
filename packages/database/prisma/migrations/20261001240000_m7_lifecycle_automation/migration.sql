-- CreateEnum
CREATE TYPE "LifecycleRuleStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "LifecycleActionType" AS ENUM ('ADD_TAG', 'CREATE_ALERT', 'SHOW_IN_ADMIN');

-- CreateEnum
CREATE TYPE "LifecycleActionStatus" AS ENUM ('PENDING', 'COMPLETED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "UserTagSource" AS ENUM ('SYSTEM', 'ADMIN');

-- CreateTable
CREATE TABLE "LifecycleRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "triggerEvent" TEXT NOT NULL,
    "conditionJson" JSONB NOT NULL DEFAULT '{}',
    "actionType" "LifecycleActionType" NOT NULL,
    "actionConfigJson" JSONB NOT NULL DEFAULT '{}',
    "status" "LifecycleRuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifecycleRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserTag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "source" "UserTagSource" NOT NULL DEFAULT 'SYSTEM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifecycleAction" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT,
    "userId" TEXT NOT NULL,
    "actionType" "LifecycleActionType" NOT NULL,
    "status" "LifecycleActionStatus" NOT NULL DEFAULT 'PENDING',
    "detailJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifecycleAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LifecycleRule_status_triggerEvent_idx" ON "LifecycleRule"("status", "triggerEvent");

-- CreateIndex
CREATE INDEX "LifecycleRule_triggerEvent_idx" ON "LifecycleRule"("triggerEvent");

-- CreateIndex
CREATE INDEX "UserTag_tag_createdAt_idx" ON "UserTag"("tag", "createdAt");

-- CreateIndex
CREATE INDEX "UserTag_userId_createdAt_idx" ON "UserTag"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserTag_userId_tag_key" ON "UserTag"("userId", "tag");

-- CreateIndex
CREATE INDEX "LifecycleAction_status_createdAt_idx" ON "LifecycleAction"("status", "createdAt");

-- CreateIndex
CREATE INDEX "LifecycleAction_userId_createdAt_idx" ON "LifecycleAction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LifecycleAction_ruleId_createdAt_idx" ON "LifecycleAction"("ruleId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserTag" ADD CONSTRAINT "UserTag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleAction" ADD CONSTRAINT "LifecycleAction_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "LifecycleRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleAction" ADD CONSTRAINT "LifecycleAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
