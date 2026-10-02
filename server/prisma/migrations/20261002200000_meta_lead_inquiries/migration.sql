-- Multiple Meta inquiries for the same lead: ONE PERSON = ONE LEAD, ONE SUBMISSION = ONE INQUIRY.
--
-- A lead row can hold one Meta submission. When a known person submitted again, the importer
-- matched them and overwrote that submission with the new one, so the earlier address was lost.
-- Each submission now gets its own row here, with its own address.
--
-- IDEMPOTENCY: "facebook_lead_id" (Meta's leadgen id) is UNIQUE, and the importer inserts with
-- ON CONFLICT DO NOTHING, so the same submission synced any number of times is one row.
--
-- ADDITIVE: no existing table, column, constraint or row is changed or removed. The duplicate
-- protection on "leads" (unique facebook_lead_id, the per-owner lower(email) index) is untouched.
-- IDEMPOTENT, like the recent migrations: safe to run twice.

CREATE TABLE IF NOT EXISTS "meta_lead_inquiries" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "facebook_lead_id" VARCHAR(64) NOT NULL,
    "facebook_page_id" VARCHAR(64),
    "facebook_form_id" VARCHAR(64),
    "meta_page_name" VARCHAR(255),
    "meta_form_name" VARCHAR(255),
    "property_address" VARCHAR(255),
    "project_name" VARCHAR(255),
    "answers" TEXT,
    "submitted_at" TIMESTAMP(0),
    "created_at" TIMESTAMP(0),

    CONSTRAINT "meta_lead_inquiries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "meta_lead_inquiries_facebook_lead_id_key" ON "meta_lead_inquiries"("facebook_lead_id");
CREATE INDEX IF NOT EXISTS "meta_lead_inquiries_lead_id_idx" ON "meta_lead_inquiries"("lead_id");

-- CASCADE, like the other lead child tables (lead_notes, lead_tasks, ...): purging a lead takes its
-- inquiries with it. A soft delete does not.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meta_lead_inquiries_lead_id_fkey') THEN
    ALTER TABLE "meta_lead_inquiries" ADD CONSTRAINT "meta_lead_inquiries_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
  END IF;
END $$;

-- BACKFILL, CONSERVATIVELY: inquiry #1 for each lead that carries a Meta lead id — the submission
-- the lead row still describes. Older submissions were overwritten and are NOT invented here.
--
-- Page, form, answers (custom_fields) and the submission time are written together with
-- facebook_lead_id, so they always describe that submission. The address ("property") is written
-- only when the importer CREATES a lead, so it is copied only when this very submission created the
-- lead — created by Meta, at the submission's own timestamp. Otherwise it stays NULL ("Not
-- provided") rather than being attributed to the wrong submission. A "property" equal to the
-- property type is the mapper's fallback, not an address, and also stays NULL. The project cannot
-- be told apart reliably from what the lead kept, so it is not backfilled.
INSERT INTO "meta_lead_inquiries" (
    "lead_id", "facebook_lead_id", "facebook_page_id", "facebook_form_id", "meta_page_name",
    "meta_form_name", "property_address", "answers", "submitted_at", "created_at"
)
SELECT
    l."id",
    btrim(l."facebook_lead_id"),
    l."facebook_page_id",
    l."facebook_form_id",
    l."meta_page_name",
    l."meta_form_name",
    CASE
        WHEN COALESCE(l."created_by", '') LIKE 'Meta%'
         AND l."meta_created_at" IS NOT NULL
         AND l."created_at" = l."meta_created_at"
        THEN NULLIF(l."property", COALESCE(l."property_type", ''))
    END,
    l."custom_fields",
    l."meta_created_at",
    COALESCE(l."meta_imported_at", l."created_at", CURRENT_TIMESTAMP)
FROM "leads" l
WHERE l."facebook_lead_id" IS NOT NULL
  AND btrim(l."facebook_lead_id") <> ''
ON CONFLICT ("facebook_lead_id") DO NOTHING;
