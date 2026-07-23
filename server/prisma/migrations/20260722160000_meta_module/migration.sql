-- Meta (Facebook / Instagram lead ads) integration.
-- Meta leads land in the existing `leads` table, so the Lead module manages them like any
-- other lead; these columns record where they came from and let a re-sync dedupe.

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source"           VARCHAR(32);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "facebook_lead_id" VARCHAR(64);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "facebook_form_id" VARCHAR(64);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "facebook_page_id" VARCHAR(64);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "message"          TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "budget"           VARCHAR(128);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "timeline"         VARCHAR(128);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "property_type"    VARCHAR(128);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "custom_fields"    TEXT;

-- Unique, so a webhook delivery and a manual sync racing on the same lead cannot both insert.
CREATE UNIQUE INDEX IF NOT EXISTS "leads_facebook_lead_id_key" ON "leads"("facebook_lead_id");
CREATE INDEX IF NOT EXISTS "leads_source_idx" ON "leads"("source");

CREATE TABLE IF NOT EXISTS "meta_connections" (
  "id"                  SERIAL       PRIMARY KEY,
  "user_id"             INTEGER      NOT NULL,
  "access_token"        TEXT         NOT NULL,
  "facebook_user_id"    VARCHAR(64),
  "facebook_user_name"  VARCHAR(255),
  "facebook_user_email" VARCHAR(255),
  "is_active"           BOOLEAN      NOT NULL DEFAULT true,
  "connected_at"        TIMESTAMP(0),
  "last_sync"           TIMESTAMP(0),
  "disconnected_at"     TIMESTAMP(0),
  "created_at"          TIMESTAMP(0),
  "updated_at"          TIMESTAMP(0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_connections_user_id_key" ON "meta_connections"("user_id");
CREATE INDEX IF NOT EXISTS "meta_connections_is_active_idx" ON "meta_connections"("is_active");

CREATE TABLE IF NOT EXISTS "meta_pages" (
  "id"            SERIAL       PRIMARY KEY,
  "connection_id" INTEGER      NOT NULL,
  "page_id"       VARCHAR(64)  NOT NULL,
  "name"          VARCHAR(255) NOT NULL,
  "access_token"  TEXT         NOT NULL,
  "created_at"    TIMESTAMP(0),
  "updated_at"    TIMESTAMP(0),
  CONSTRAINT "meta_pages_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "meta_connections"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_pages_connection_id_page_id_key" ON "meta_pages"("connection_id", "page_id");
CREATE INDEX IF NOT EXISTS "meta_pages_page_id_idx" ON "meta_pages"("page_id");

CREATE TABLE IF NOT EXISTS "meta_lead_forms" (
  "id"         SERIAL       PRIMARY KEY,
  "user_id"    INTEGER      NOT NULL,
  "form_id"    VARCHAR(64)  NOT NULL,
  "page_id"    VARCHAR(64)  NOT NULL,
  "form_name"  VARCHAR(255),
  "is_active"  BOOLEAN      NOT NULL DEFAULT true,
  "last_sync"  TIMESTAMP(0),
  "created_at" TIMESTAMP(0),
  "updated_at" TIMESTAMP(0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_lead_forms_user_id_form_id_page_id_key" ON "meta_lead_forms"("user_id", "form_id", "page_id");
CREATE INDEX IF NOT EXISTS "meta_lead_forms_page_id_idx"   ON "meta_lead_forms"("page_id");
CREATE INDEX IF NOT EXISTS "meta_lead_forms_is_active_idx" ON "meta_lead_forms"("is_active");
