-- CELEBRATION & WISHES: festival, birthday, anniversary and general greetings, built on Campaigns.
--
-- A celebration is a CAMPAIGN (`campaigns.kind = 'celebration'`) so it shares the existing send
-- engine: background delivery, per-recipient claim-then-send, consent re-checked at dispatch, the
-- unsubscribe link and suppression list, tracking, scheduling, cancel and resume. Every column added
-- to `campaigns` and `campaign_recipients` is nullable or defaulted, and the standard campaign path
-- never reads them, so existing campaigns behave exactly as before.
--
-- campaigns.status for a celebration: draft | scheduled | sending | completed | partial | failed
-- campaign_recipients.status adds:     skipped   never attempted — no longer eligible at send time
--                                      diverted  handed to the mail server on a machine whose mail
--                                                safety diverts it (MAIL_REDIRECT_TO / dev sink) —
--                                                NOT delivered to the recipient, never counted as sent

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "kind"           VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "occasion"       VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "occasion_label" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "preview_text"   VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "reply_to"       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "message"        TEXT,
  ADD COLUMN IF NOT EXISTS "branding"       VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "timezone"       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "flyer_id"       INTEGER,
  ADD COLUMN IF NOT EXISTS "automation_id"  INTEGER,
  ADD COLUMN IF NOT EXISTS "ai_assisted"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "skipped"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "diverted"       INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "campaigns_kind_idx" ON "campaigns"("kind");

ALTER TABLE "campaign_recipients"
  ADD COLUMN IF NOT EXISTS "provider_message_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "sent_at"             TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "failure_kind"        VARCHAR(16);

-- The flyer image, stored like campaign template attachments (bytes in the row) so a scheduled
-- send days later still has exactly the image that was previewed. Soft-deleted only: a campaign or
-- automation that names a flyer keeps rendering it.
CREATE TABLE IF NOT EXISTS "campaign_flyers" (
  "id"            SERIAL        PRIMARY KEY,
  "created_by_id" INTEGER,
  "source"        VARCHAR(16)   NOT NULL,
  "mime"          VARCHAR(32)   NOT NULL,
  "width"         INTEGER       NOT NULL,
  "height"        INTEGER       NOT NULL,
  "size"          INTEGER       NOT NULL,
  "data"          BYTEA         NOT NULL,
  "alt_text"      VARCHAR(255)  NOT NULL,
  "settings"      TEXT,
  "created_at"    TIMESTAMP(0)  NOT NULL,
  "updated_at"    TIMESTAMP(0)  NOT NULL,
  "deleted_at"    TIMESTAMP(0),
  CONSTRAINT "campaign_flyers_source_chk" CHECK ("source" IN ('upload', 'template'))
);
CREATE INDEX IF NOT EXISTS "campaign_flyers_created_by_id_idx" ON "campaign_flyers"("created_by_id");

-- Annual birthday / anniversary rules. Created PAUSED: nothing recurring sends until somebody
-- switches a rule on. The content is the saved template — a run never generates new AI content.
CREATE TABLE IF NOT EXISTS "celebration_automations" (
  "id"                SERIAL        PRIMARY KEY,
  "created_by_id"     INTEGER       NOT NULL,
  "created_by"        VARCHAR(255),
  "name"              VARCHAR(255)  NOT NULL,
  "occasion"          VARCHAR(16)   NOT NULL,
  "status"            VARCHAR(16)   NOT NULL DEFAULT 'paused',
  "subject"           VARCHAR(500)  NOT NULL,
  "preview_text"      VARCHAR(255),
  "message"           TEXT          NOT NULL,
  "branding"          VARCHAR(16)   NOT NULL DEFAULT 'agent',
  "flyer_id"          INTEGER,
  "sender_account_id" INTEGER,
  "reply_to"          VARCHAR(255),
  "send_time"         VARCHAR(5)    NOT NULL DEFAULT '09:00',
  "timezone"          VARCHAR(64)   NOT NULL,
  "feb29_rule"        VARCHAR(8)    NOT NULL DEFAULT 'feb28',
  "filters"           TEXT,
  "last_run_on"       DATE,
  "last_run_at"       TIMESTAMP(3),
  "last_run_summary"  TEXT,
  "created_at"        TIMESTAMP(0)  NOT NULL,
  "updated_at"        TIMESTAMP(0)  NOT NULL,
  "deleted_at"        TIMESTAMP(0),
  CONSTRAINT "celebration_automations_occasion_chk" CHECK ("occasion" IN ('birthday', 'anniversary')),
  CONSTRAINT "celebration_automations_status_chk" CHECK ("status" IN ('active', 'paused')),
  CONSTRAINT "celebration_automations_feb29_chk" CHECK ("feb29_rule" IN ('feb28', 'mar1', 'skip'))
);
CREATE INDEX IF NOT EXISTS "celebration_automations_created_by_id_idx" ON "celebration_automations"("created_by_id");
CREATE INDEX IF NOT EXISTS "celebration_automations_status_idx" ON "celebration_automations"("status");

-- THE DURABLE "ALREADY GREETED" MARK: one greeting per address, occasion and year, across every
-- celebration campaign and automation. Written immediately before the message is handed to the mail
-- server (in the recipient claim), so two passes, two campaigns or two processes cannot both send.
-- Released again only when the send certainly did not happen, so a retry stays possible.
CREATE TABLE IF NOT EXISTS "celebration_sends" (
  "id"           SERIAL        PRIMARY KEY,
  "occasion_key" VARCHAR(80)   NOT NULL,
  "email_key"    VARCHAR(255)  NOT NULL,
  "year"         INTEGER       NOT NULL,
  "lead_id"      INTEGER,
  "campaign_id"  INTEGER,
  "recipient_id" INTEGER,
  "created_at"   TIMESTAMP(3)  NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "celebration_sends_occasion_email_year_key" ON "celebration_sends"("occasion_key", "email_key", "year");
CREATE INDEX IF NOT EXISTS "celebration_sends_campaign_id_idx" ON "celebration_sends"("campaign_id");

-- LET THE APPLICATION USE THEM. Migrations run as the owner while the app connects as its own user,
-- and there are no default privileges (the lesson of 20261019130000_payment_sheet_rows_access).
-- Granted to exactly whoever can already use `campaigns`, plus its owner when that is not postgres.
-- Re-running it changes nothing.
DO $$
DECLARE r record; t text;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee AS role FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'campaigns' AND privilege_type = 'SELECT'
       AND grantee NOT IN ('postgres', 'PUBLIC')
    UNION
    SELECT tableowner FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'campaigns' AND tableowner <> 'postgres'
  LOOP
    FOREACH t IN ARRAY ARRAY['campaign_flyers', 'celebration_automations', 'celebration_sends'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I', t, r.role);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', t || '_id_seq', r.role);
    END LOOP;
  END LOOP;
END $$;
