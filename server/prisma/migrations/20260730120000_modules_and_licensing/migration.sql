-- Module assignment and product licensing.
--
-- Two new tables and two new columns. Nothing existing is altered or removed, and the backfill is
-- written so that on the morning after this runs every person sees exactly what they saw before:
-- every user is assigned BOTH modules, and the single company is licensed for BOTH.
--
-- Access is the pair of two independent facts:
--
--   licensed  — the company bought the module          (subscriptions)
--   assigned  — this person may open it                (user_modules)
--
-- Both are required. They are kept apart on purpose: ending a subscription must not erase who was
-- assigned what, or resubscribing would come back to a blank slate instead of the arrangement the
-- brokerage had.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Where a person sits in the organisation
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "department"  VARCHAR(120);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "designation" VARCHAR(120);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Module assignment
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "user_modules" (
  "id"          SERIAL       PRIMARY KEY,
  "user_id"     INTEGER      NOT NULL,
  "module_name" VARCHAR(16)  NOT NULL,
  "status"      VARCHAR(16)  NOT NULL DEFAULT 'active',
  "created_at"  TIMESTAMP(0),
  "updated_at"  TIMESTAMP(0),
  CONSTRAINT "user_modules_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- Assigning the same module twice is the same fact, not two.
CREATE UNIQUE INDEX IF NOT EXISTS "user_modules_user_id_module_name_key" ON "user_modules"("user_id", "module_name");
CREATE INDEX IF NOT EXISTS "user_modules_module_name_idx" ON "user_modules"("module_name");

-- Every existing user gets both modules, because that is what they have today: module access did not
-- exist as a concept, so everyone could reach everything their screen permissions allowed. Granting
-- less here would silently take access away from people, which is the one thing this must not do.
--
-- Screen permissions are untouched and still decide what someone may open WITHIN a module. This table
-- only decides which modules exist for them at all.
INSERT INTO "user_modules" ("user_id", "module_name", "status", "created_at", "updated_at")
SELECT u."id", m."module_name", 'active', NOW(), NOW()
  FROM "users" u
 CROSS JOIN (VALUES ('crm'), ('desk')) AS m("module_name")
ON CONFLICT ("user_id", "module_name") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Licensing
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id"                  SERIAL       PRIMARY KEY,
  "company_id"          INTEGER      NOT NULL,
  "crm_enabled"         BOOLEAN      NOT NULL DEFAULT TRUE,
  "transaction_enabled" BOOLEAN      NOT NULL DEFAULT TRUE,
  "plan"                VARCHAR(64),
  "expiry_date"         DATE,
  "status"              VARCHAR(16)  NOT NULL DEFAULT 'active',
  "created_at"          TIMESTAMP(0),
  "updated_at"          TIMESTAMP(0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_company_id_key" ON "subscriptions"("company_id");

-- One row per company in `company_settings` — which is one row, id 1. Both modules enabled, no expiry:
-- this deployment already runs both, and a licence that switched something off on the day it was
-- introduced would be a regression dressed as a feature.
INSERT INTO "subscriptions" ("company_id", "crm_enabled", "transaction_enabled", "plan", "expiry_date", "status", "created_at", "updated_at")
SELECT c."id", TRUE, TRUE, 'full', NULL, 'active', NOW(), NOW()
  FROM "company_settings" c
ON CONFLICT ("company_id") DO NOTHING;
