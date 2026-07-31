-- Background CSV lead imports.
--
-- Importing used to happen inline, one row at a time, inside the request that asked for it.
-- Measured against 40,000 existing leads a 5,000-row file spent ~132 seconds in lookups alone —
-- past a default proxy timeout — and because nothing wrapped it, a timeout left a partially
-- imported file with no rollback and no way to resume. This table carries the work instead: the
-- request enqueues and returns immediately, and the client polls these counters for progress.
--
-- `payload` holds the CSV only while the job is pending and is cleared on completion, so this
-- table does not accumulate the uploaded files forever.
CREATE TABLE IF NOT EXISTS "lead_import_jobs" (
    "id"              SERIAL       NOT NULL,
    "job_id"          VARCHAR(64)  NOT NULL,
    "status"          VARCHAR(24)  NOT NULL DEFAULT 'Queued',
    "source"          VARCHAR(24)  NOT NULL DEFAULT 'leads',
    "tag"             VARCHAR(190),
    "payload"         TEXT,
    "total_rows"      INTEGER      NOT NULL DEFAULT 0,
    "processed_rows"  INTEGER      NOT NULL DEFAULT 0,
    "imported"        INTEGER      NOT NULL DEFAULT 0,
    "tagged"          INTEGER      NOT NULL DEFAULT 0,
    "duplicate"       INTEGER      NOT NULL DEFAULT 0,
    "invalid"         INTEGER      NOT NULL DEFAULT 0,
    "failure_reason"  TEXT,
    "requested_by"    VARCHAR(255),
    "requested_by_id" INTEGER,
    "requested_at"    TIMESTAMP(0),
    "started_at"      TIMESTAMP(0),
    "completed_at"    TIMESTAMP(0),
    "created_at"      TIMESTAMP(0),
    "updated_at"      TIMESTAMP(0),
    "company_id"      INTEGER      NOT NULL DEFAULT 1,

    CONSTRAINT "lead_import_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "lead_import_jobs_job_id_key"       ON "lead_import_jobs"("job_id");
CREATE INDEX        IF NOT EXISTS "lead_import_jobs_status_idx"       ON "lead_import_jobs"("status");
CREATE INDEX        IF NOT EXISTS "lead_import_jobs_requested_by_id_idx" ON "lead_import_jobs"("requested_by_id");
CREATE INDEX        IF NOT EXISTS "lead_import_jobs_company_id_idx"   ON "lead_import_jobs"("company_id");

DO $$ BEGIN
  ALTER TABLE "lead_import_jobs"
    ADD CONSTRAINT "lead_import_jobs_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
