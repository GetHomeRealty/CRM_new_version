-- Leads module: richer lead record + note / task / showing / call history + a tag registry.
-- The `leads` table already existed (created for Campaigns); this widens it rather than
-- replacing it, so every campaign audience and recipient link keeps working.

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_response"        VARCHAR(48);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_conversion"      VARCHAR(24);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "property"             VARCHAR(255);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "notes"                TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "gender"               VARCHAR(24);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "language"             VARCHAR(64);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "religion"             VARCHAR(64);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "age"                  INTEGER;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "date_of_birth"        DATE;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "marriage_day"         DATE;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "property_preferences" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "assigned_to"          INTEGER;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "deleted_by"           VARCHAR(255);

CREATE INDEX IF NOT EXISTS "leads_assigned_to_idx" ON "leads"("assigned_to");
CREATE INDEX IF NOT EXISTS "leads_deleted_at_idx"  ON "leads"("deleted_at");

CREATE TABLE IF NOT EXISTS "lead_notes" (
  "id"         SERIAL       PRIMARY KEY,
  "lead_id"    INTEGER      NOT NULL,
  "content"    TEXT         NOT NULL,
  "pinned"     BOOLEAN      NOT NULL DEFAULT false,
  "created_by" VARCHAR(255),
  "user_id"    INTEGER,
  "created_at" TIMESTAMP(0),
  "updated_at" TIMESTAMP(0),
  CONSTRAINT "lead_notes_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "lead_notes_lead_id_idx" ON "lead_notes"("lead_id");

CREATE TABLE IF NOT EXISTS "lead_tasks" (
  "id"          SERIAL       PRIMARY KEY,
  "lead_id"     INTEGER      NOT NULL,
  "title"       VARCHAR(255) NOT NULL,
  "due_date"    DATE         NOT NULL,
  "description" TEXT,
  "status"      VARCHAR(16)  NOT NULL DEFAULT 'pending',
  "priority"    VARCHAR(16)  NOT NULL DEFAULT 'medium',
  "assigned_to" INTEGER,
  "created_by"  VARCHAR(255),
  "user_id"     INTEGER,
  "created_at"  TIMESTAMP(0),
  "updated_at"  TIMESTAMP(0),
  CONSTRAINT "lead_tasks_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "lead_tasks_lead_id_idx"     ON "lead_tasks"("lead_id");
CREATE INDEX IF NOT EXISTS "lead_tasks_status_idx"      ON "lead_tasks"("status");
CREATE INDEX IF NOT EXISTS "lead_tasks_assigned_to_idx" ON "lead_tasks"("assigned_to");

CREATE TABLE IF NOT EXISTS "lead_showings" (
  "id"           SERIAL       PRIMARY KEY,
  "lead_id"      INTEGER      NOT NULL,
  "showing_date" DATE         NOT NULL,
  "time"         VARCHAR(8)   NOT NULL,
  "property"     VARCHAR(255),
  "notes"        TEXT,
  "status"       VARCHAR(16)  NOT NULL DEFAULT 'scheduled',
  "created_by"   VARCHAR(255),
  "user_id"      INTEGER,
  "created_at"   TIMESTAMP(0),
  "updated_at"   TIMESTAMP(0),
  CONSTRAINT "lead_showings_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "lead_showings_lead_id_idx"      ON "lead_showings"("lead_id");
CREATE INDEX IF NOT EXISTS "lead_showings_showing_date_idx" ON "lead_showings"("showing_date");

CREATE TABLE IF NOT EXISTS "lead_calls" (
  "id"         SERIAL       PRIMARY KEY,
  "lead_id"    INTEGER      NOT NULL,
  "called_at"  TIMESTAMP(0) NOT NULL,
  "duration"   INTEGER,
  "outcome"    VARCHAR(32),
  "notes"      TEXT,
  "created_by" VARCHAR(255),
  "user_id"    INTEGER,
  "created_at" TIMESTAMP(0),
  CONSTRAINT "lead_calls_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "lead_calls_lead_id_idx" ON "lead_calls"("lead_id");

CREATE TABLE IF NOT EXISTS "lead_tags" (
  "id"         SERIAL      PRIMARY KEY,
  "name"       VARCHAR(64) NOT NULL,
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMP(0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "lead_tags_name_key" ON "lead_tags"("name");
