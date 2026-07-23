-- CRM Settings migration.
--
-- Purely additive: new tables plus one nullable column on `users`. Transaction Desk's own
-- settings (company_settings, mail_accounts, email_templates) are not touched, and duplication
-- between the two settings surfaces is expected at this stage.

-- Personal Information in CRM Settings edits a phone number; users had no such column.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" VARCHAR(64);

CREATE TABLE IF NOT EXISTS "crm_settings" (
  "id"             SERIAL PRIMARY KEY,
  "user_id"        INTEGER,
  "notifications"  TEXT,
  "email_settings" TEXT,
  "preferences"    TEXT,
  "templates"      TEXT,
  "updated_by"     VARCHAR(255),
  "created_at"     TIMESTAMP(0),
  "updated_at"     TIMESTAMP(0)
);
-- One row per user, and exactly one global row (user_id IS NULL) — a partial unique index,
-- since Postgres treats every NULL as distinct in a plain unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "crm_settings_user_id_key" ON "crm_settings"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "crm_settings_global_key" ON "crm_settings"(("user_id" IS NULL)) WHERE "user_id" IS NULL;

CREATE TABLE IF NOT EXISTS "crm_email_settings" (
  "id"                SERIAL PRIMARY KEY,
  "smtp_host"         VARCHAR(255),
  "smtp_port"         VARCHAR(16),
  "smtp_user"         VARCHAR(255),
  "admin_email"       VARCHAR(255),
  "auto_send_enabled" BOOLEAN NOT NULL DEFAULT true,
  "template_toggles"  TEXT,
  "updated_by"        VARCHAR(255),
  "created_at"        TIMESTAMP(0),
  "updated_at"        TIMESTAMP(0)
);

CREATE TABLE IF NOT EXISTS "crm_referral_codes" (
  "id"          SERIAL PRIMARY KEY,
  "code"        VARCHAR(32)  NOT NULL,
  "discount"    INTEGER      NOT NULL DEFAULT 10,
  "valid_until" TIMESTAMP(0) NOT NULL,
  "usage_count" INTEGER      NOT NULL DEFAULT 0,
  "max_usage"   INTEGER      NOT NULL DEFAULT 5,
  "created_by"  VARCHAR(255),
  "created_at"  TIMESTAMP(0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "crm_referral_codes_code_key" ON "crm_referral_codes"("code");

CREATE TABLE IF NOT EXISTS "crm_email_log" (
  "id"         SERIAL PRIMARY KEY,
  "kind"       VARCHAR(32)  NOT NULL,
  "lead_name"  VARCHAR(255),
  "recipient"  VARCHAR(255) NOT NULL,
  "subject"    VARCHAR(500),
  "success"    BOOLEAN      NOT NULL DEFAULT false,
  "error"      TEXT,
  "redirected" VARCHAR(255),
  "sent_by"    VARCHAR(255),
  "created_at" TIMESTAMP(0)
);
CREATE INDEX IF NOT EXISTS "crm_email_log_kind_idx"       ON "crm_email_log"("kind");
CREATE INDEX IF NOT EXISTS "crm_email_log_created_at_idx" ON "crm_email_log"("created_at");

CREATE TABLE IF NOT EXISTS "crm_broadcasts" (
  "id"         SERIAL PRIMARY KEY,
  "message"    TEXT        NOT NULL,
  "type"       VARCHAR(16) NOT NULL DEFAULT 'info',
  "recipients" INTEGER     NOT NULL DEFAULT 0,
  "sent_by"    VARCHAR(255),
  "sent_by_id" INTEGER,
  "created_at" TIMESTAMP(0)
);
CREATE INDEX IF NOT EXISTS "crm_broadcasts_created_at_idx" ON "crm_broadcasts"("created_at");
