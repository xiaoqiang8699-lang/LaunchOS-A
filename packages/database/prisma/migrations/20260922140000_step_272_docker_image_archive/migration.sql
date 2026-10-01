-- Step 27.2: DOCKER_IMAGE archive metadata + deployable artifact binding
ALTER TABLE "Artifact" ADD COLUMN IF NOT EXISTS "checksum" TEXT;
ALTER TABLE "Artifact" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "deployableArtifactId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Deployment_deployableArtifactId_fkey'
  ) THEN
    ALTER TABLE "Deployment"
      ADD CONSTRAINT "Deployment_deployableArtifactId_fkey"
      FOREIGN KEY ("deployableArtifactId") REFERENCES "Artifact"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Deployment_deployableArtifactId_idx" ON "Deployment"("deployableArtifactId");
