-- CreateTable
CREATE TABLE "CloudPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cpu" INTEGER NOT NULL,
    "memory" TEXT NOT NULL,
    "storage" TEXT NOT NULL,
    "database" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CloudPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceRecommendation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CloudPlan_name_key" ON "CloudPlan"("name");

-- CreateIndex
CREATE INDEX "ResourceRecommendation_projectId_createdAt_idx" ON "ResourceRecommendation"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "ResourceRecommendation" ADD CONSTRAINT "ResourceRecommendation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceRecommendation" ADD CONSTRAINT "ResourceRecommendation_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CloudPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Mock cloud plans (no billing, no real providers)
INSERT INTO "CloudPlan" ("id", "name", "cpu", "memory", "storage", "database", "description", "createdAt") VALUES
('cloudplan_starter', 'Starter', 1, '1GB', '10GB', 'none', 'Minimal Node.js runtime for simple apps without a database.', CURRENT_TIMESTAMP),
('cloudplan_standard', 'Standard', 2, '4GB', '40GB', 'PostgreSQL', 'Application runtime plus PostgreSQL for projects that persist data.', CURRENT_TIMESTAMP),
('cloudplan_production', 'Production', 4, '8GB', '80GB', 'PostgreSQL + Redis', 'Higher capacity runtime with PostgreSQL and Redis for complex workloads.', CURRENT_TIMESTAMP);
