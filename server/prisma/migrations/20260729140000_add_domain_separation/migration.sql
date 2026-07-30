-- Phase 1 of separating Customer Relationship Management from Transaction Management:
-- the `domain` column that tells the two areas' records apart, on the three tables whose rows
-- can belong to either side.
--
-- The values are 'crm', 'desk' and 'common', matching `mail_accounts.scope` and
-- `google_connections.scope` — two columns already live in this database carrying exactly this
-- distinction. A second vocabulary for the same idea would mean every query and guard had to
-- know which of the two it was reading.
--
-- NULL is not a fourth domain. It is the honest state for history that pre-dates the split and
-- cannot be attributed, and unclassified rows are shown in BOTH areas so the separation never
-- makes an existing record disappear from anyone's view.
--
-- Nothing here deletes or rewrites existing data: three added columns and UPDATEs that only
-- ever move a row from NULL to a value.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "audit_logs"      ADD COLUMN IF NOT EXISTS "domain" VARCHAR(8);
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "domain" VARCHAR(8);
ALTER TABLE "todos"           ADD COLUMN IF NOT EXISTS "domain" VARCHAR(8);

CREATE INDEX IF NOT EXISTS "audit_logs_domain_idx"      ON "audit_logs"("domain");
CREATE INDEX IF NOT EXISTS "calendar_events_domain_idx" ON "calendar_events"("domain");
CREATE INDEX IF NOT EXISTS "todos_domain_idx"           ON "todos"("domain");

-- `lead_tasks` deliberately gets no domain column: its `lead_id` is NOT NULL and cascades from
-- `leads`, so every row is a CRM task by construction. A column that can only ever hold one
-- value is not a distinction.

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. audit_logs — fully deterministic, every existing row classifies
-- ─────────────────────────────────────────────────────────────────────────────
-- Ordered most specific first. Each statement is guarded on `domain IS NULL`, so re-running is
-- harmless and an earlier rule always wins over a later one.

-- A transaction link IS the domain. Nothing else needs to be consulted.
UPDATE "audit_logs" SET "domain" = 'desk'
 WHERE "domain" IS NULL AND "transaction_id" IS NOT NULL;

UPDATE "audit_logs" SET "domain" = 'crm'
 WHERE "domain" IS NULL AND "category" = 'Lead';

UPDATE "audit_logs" SET "domain" = 'crm'
 WHERE "domain" IS NULL AND "category" = 'Settings' AND "section" = 'CRM Settings';

-- Company Settings, Users and Inventory are shared modules: an administrator's change there is
-- not CRM history or Transaction history, it is both. Hiding it from one side would lose the
-- audit trail rather than separate it.
UPDATE "audit_logs" SET "domain" = 'common'
 WHERE "domain" IS NULL AND "category" = 'Settings' AND "section" = 'Company Settings';

UPDATE "audit_logs" SET "domain" = 'common'
 WHERE "domain" IS NULL AND "category" IN ('Users', 'Marketing Inventory');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. calendar_events — only what is genuinely attributable
-- ─────────────────────────────────────────────────────────────────────────────
-- Every row in this table arrived from Google (`created_by = 'Google Calendar'`) and none carries
-- a transaction or lead link, so the local data cannot classify them. The attribution below came
-- from listing both connected calendars and asking which account each event actually exists in:
--
--     deals@gethomerealty.ca         (scope 'crm')   — 42 masters / 523 instances
--     commissionpayouts@…            (scope 'desk')  — 34 masters / 512 instances
--
--   23 rows  present in the Transaction Desk calendar only  → 'desk' (below)
--    0 rows  present in the CRM calendar only
--   22 rows  present in BOTH calendars                      → left NULL, genuinely ambiguous
--  265 rows  in neither (synced before, since removed there) → left NULL
--
-- The 23 are three recurring series, matched on the Google master id rather than on 23 primary
-- keys: the master id is what identifies the series, survives a re-sync, and says on its face
-- which events are meant. Verified to match exactly 23 live rows and no others.
UPDATE "calendar_events" SET "domain" = 'desk'
 WHERE "domain" IS NULL
   AND "deleted_at" IS NULL
   AND split_part("google_calendar_id", '_', 1) IN (
     'v2f8oq3lul3ej47ele7mmvv6pl',  -- Accounts Projection Call (recurring, 21 instances)
     '1msf710b3s440u691foi2koahe',  -- Reminder-Meeting of Creditors @11AM EST
     '1p3qr0c3lcfc3uithcpebgk26f'   -- Reminder for Aug 13 Meeting of Creditors
   );

-- Any calendar event created from a transaction from here on classifies itself. Included so the
-- rule is applied to rows added between this migration being written and being deployed.
UPDATE "calendar_events" SET "domain" = 'desk'
 WHERE "domain" IS NULL AND "transaction_id" IS NOT NULL;

UPDATE "calendar_events" SET "domain" = 'crm'
 WHERE "domain" IS NULL AND "transaction_id" IS NULL AND "lead_id" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. todos
-- ─────────────────────────────────────────────────────────────────────────────
-- The one existing row has no link to either area, so it is left NULL and appears in both
-- To-Do lists. Guessing would be worse than showing it twice: an unassigned task hidden from
-- the half of the application its owner works in is a task that gets missed.
