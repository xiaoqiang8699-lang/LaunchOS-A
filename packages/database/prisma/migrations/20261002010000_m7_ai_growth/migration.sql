-- CreateEnum
DO $$ BEGIN CREATE TYPE "AIRecommendationType" AS ENUM ('USER_RISK', 'PRODUCT_ISSUE', 'GROWTH_OPPORTUNITY', 'SYSTEM_WARNING'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AIRecommendationPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "AIOperationRecommendation" (
    "id" TEXT NOT NULL,
    "type" "AIRecommendationType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "priority" "AIRecommendationPriority" NOT NULL DEFAULT 'MEDIUM',
    "source" TEXT NOT NULL DEFAULT 'AI_GROWTH',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AIOperationRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AIPromptTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AIPromptTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AIPromptTemplate_name_key" ON "AIPromptTemplate"("name");
CREATE INDEX IF NOT EXISTS "AIPromptTemplate_name_idx" ON "AIPromptTemplate"("name");
CREATE INDEX IF NOT EXISTS "AIOperationRecommendation_type_createdAt_idx" ON "AIOperationRecommendation"("type", "createdAt");
CREATE INDEX IF NOT EXISTS "AIOperationRecommendation_priority_createdAt_idx" ON "AIOperationRecommendation"("priority", "createdAt");
