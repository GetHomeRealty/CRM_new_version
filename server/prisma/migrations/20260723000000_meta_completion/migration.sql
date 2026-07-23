-- Meta integration completion: attribution, token lifecycle, webhook idempotency, sync history
-- and an optional lead link on calendar events.
--
-- Purely additive. No existing column is altered or dropped, and nothing in the transaction /
-- document / invoice / commission core is touched.

-- ---- lead attribution -----------------------------------------------------
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "first_name"         VARCHAR(128);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "last_name"          VARCHAR(128);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "phone_normalized"   VARCHAR(32);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_page_name"     VARCHAR(255);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_form_name"     VARCHAR(255);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_campaign_id"   VARCHAR(64);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_campaign_name" VARCHAR(255);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_adset_id"      VARCHAR(64);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_adset_name"    VARCHAR(255);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_ad_id"         VARCHAR(64);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_ad_name"       VARCHAR(255);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_created_at"    TIMESTAMP(0);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_imported_at"   TIMESTAMP(0);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "meta_raw"           TEXT;

CREATE INDEX IF NOT EXISTS "leads_phone_normalized_idx" ON "leads"("phone_normalized");
CREATE INDEX IF NOT EXISTS "leads_meta_campaign_id_idx" ON "leads"("meta_campaign_id");

-- ---- connection token lifecycle & diagnostics ------------------------------
ALTER TABLE "meta_connections" ADD COLUMN IF NOT EXISTS "token_expires_at" TIMESTAMP(0);
ALTER TABLE "meta_connections" ADD COLUMN IF NOT EXISTS "granted_scopes"   TEXT;
ALTER TABLE "meta_connections" ADD COLUMN IF NOT EXISTS "ad_account_id"    VARCHAR(64);
ALTER TABLE "meta_connections" ADD COLUMN IF NOT EXISTS "ad_account_name"  VARCHAR(255);
ALTER TABLE "meta_connections" ADD COLUMN IF NOT EXISTS "last_error"       TEXT;
ALTER TABLE "meta_connections" ADD COLUMN IF NOT EXISTS "last_error_at"    TIMESTAMP(0);
ALTER TABLE "meta_connections" ADD COLUMN IF NOT EXISTS "last_webhook_at"  TIMESTAMP(0);
CREATE INDEX IF NOT EXISTS "meta_connections_token_expires_at_idx" ON "meta_connections"("token_expires_at");

ALTER TABLE "meta_lead_forms" ADD COLUMN IF NOT EXISTS "page_name" VARCHAR(255);

-- ---- webhook idempotency ---------------------------------------------------
CREATE TABLE IF NOT EXISTS "meta_webhook_events" (
  "id"           SERIAL       PRIMARY KEY,
  "event_key"    VARCHAR(200) NOT NULL,
  "leadgen_id"   VARCHAR(64),
  "form_id"      VARCHAR(64),
  "page_id"      VARCHAR(64),
  "status"       VARCHAR(16)  NOT NULL DEFAULT 'received',
  "error"        TEXT,
  "lead_id"      INTEGER,
  "attempts"     INTEGER      NOT NULL DEFAULT 1,
  "payload"      TEXT,
  "received_at"  TIMESTAMP(0) NOT NULL,
  "processed_at" TIMESTAMP(0)
);
-- The unique key is what makes a retried delivery a no-op instead of a second lead.
CREATE UNIQUE INDEX IF NOT EXISTS "meta_webhook_events_event_key_key" ON "meta_webhook_events"("event_key");
CREATE INDEX IF NOT EXISTS "meta_webhook_events_status_idx"      ON "meta_webhook_events"("status");
CREATE INDEX IF NOT EXISTS "meta_webhook_events_leadgen_id_idx"  ON "meta_webhook_events"("leadgen_id");
CREATE INDEX IF NOT EXISTS "meta_webhook_events_received_at_idx" ON "meta_webhook_events"("received_at");

-- ---- sync history ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "meta_sync_history" (
  "id"          SERIAL       PRIMARY KEY,
  "user_id"     INTEGER      NOT NULL,
  "trigger"     VARCHAR(16)  NOT NULL DEFAULT 'manual',
  "forms_read"  INTEGER      NOT NULL DEFAULT 0,
  "imported"    INTEGER      NOT NULL DEFAULT 0,
  "updated"     INTEGER      NOT NULL DEFAULT 0,
  "skipped"     INTEGER      NOT NULL DEFAULT 0,
  "duplicates"  INTEGER      NOT NULL DEFAULT 0,
  "errors"      TEXT,
  "started_at"  TIMESTAMP(0) NOT NULL,
  "finished_at" TIMESTAMP(0)
);
CREATE INDEX IF NOT EXISTS "meta_sync_history_user_id_idx"    ON "meta_sync_history"("user_id");
CREATE INDEX IF NOT EXISTS "meta_sync_history_started_at_idx" ON "meta_sync_history"("started_at");

-- ---- calendar events can hang off a lead -----------------------------------
-- Nullable and unconstrained by anything existing: every current event keeps lead_id NULL and
-- the Calendar module behaves exactly as before.
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "lead_id" INTEGER;
CREATE INDEX IF NOT EXISTS "calendar_events_lead_id_idx" ON "calendar_events"("lead_id");

-- Backfill the normalized phone for existing leads so duplicate detection works on day one.
UPDATE "leads"
   SET "phone_normalized" = NULLIF(REGEXP_REPLACE(COALESCE("phone", ''), '[^0-9]', '', 'g'), '')
 WHERE "phone" IS NOT NULL AND "phone_normalized" IS NULL;
