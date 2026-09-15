-- Lead Type now stores a JSON array so a lead can belong to more than one segment.
-- Existing single values remain readable by the API and are converted here for consistency.
ALTER TABLE "leads" ALTER COLUMN "lead_type" TYPE TEXT;

UPDATE "leads"
SET "lead_type" = json_build_array("lead_type")::text
WHERE "lead_type" IS NOT NULL
  AND btrim("lead_type") <> ''
  AND left(btrim("lead_type"), 1) <> '[';
