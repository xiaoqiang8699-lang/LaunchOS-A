-- Pro plan: allow up to 2 workspace members (was 1).
UPDATE "Plan"
SET
  "maxMembers" = 2,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE code = 'pro';

-- Active catalog version(s)
UPDATE "PlanVersion" pv
SET
  "limitsJson" = jsonb_set(
    jsonb_set(COALESCE(pv."limitsJson", '{}'::jsonb), '{maxMembers}', '2'::jsonb, true),
    '{maxWorkspaceMembers}',
    '2'::jsonb,
    true
  )
FROM "Plan" p
WHERE pv."planId" = p.id
  AND p.code = 'pro'
  AND pv."effectiveTo" IS NULL;

-- Pinned / historical versions (Alpha may have no open PlanVersion row)
UPDATE "PlanVersion" pv
SET
  "limitsJson" = jsonb_set(
    jsonb_set(COALESCE(pv."limitsJson", '{}'::jsonb), '{maxMembers}', '2'::jsonb, true),
    '{maxWorkspaceMembers}',
    '2'::jsonb,
    true
  )
FROM "Plan" p
WHERE pv."planId" = p.id
  AND p.code = 'pro';
