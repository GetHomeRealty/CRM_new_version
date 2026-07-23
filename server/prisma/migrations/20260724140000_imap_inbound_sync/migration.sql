-- IMAP inbound email sync.
--
-- Additive: SMTP-only mail accounts leave the new columns null and are unaffected. inbound_emails
-- holds messages pulled from a user's mailbox, private to the owner and deduped per (account, UID).

ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "imap_host"       VARCHAR(255);
ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "imap_port"       INTEGER;
ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "imap_encryption" VARCHAR(8);
ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "inbound_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "last_uid"        INTEGER;
ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "last_synced_at"  TIMESTAMP(0);
ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "sync_error"      VARCHAR(500);

CREATE TABLE IF NOT EXISTS "inbound_emails" (
  "id"          SERIAL PRIMARY KEY,
  "user_id"     INTEGER      NOT NULL,
  "account_id"  INTEGER      NOT NULL,
  "uid"         INTEGER      NOT NULL,
  "message_id"  VARCHAR(512),
  "from_email"  VARCHAR(320),
  "from_name"   VARCHAR(255),
  "to_email"    VARCHAR(320),
  "subject"     VARCHAR(998),
  "snippet"     VARCHAR(300),
  "body_text"   TEXT,
  "body_html"   TEXT,
  "received_at" TIMESTAMP(0) NOT NULL,
  "seen"        BOOLEAN      NOT NULL DEFAULT false,
  "lead_id"     INTEGER,
  "created_at"  TIMESTAMP(0),
  CONSTRAINT "inbound_emails_account_id_fkey" FOREIGN KEY ("account_id")
    REFERENCES "mail_accounts"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "inbound_emails_lead_id_fkey" FOREIGN KEY ("lead_id")
    REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "inbound_emails_account_id_uid_key" ON "inbound_emails"("account_id", "uid");
CREATE INDEX IF NOT EXISTS "inbound_emails_user_id_idx" ON "inbound_emails"("user_id");
CREATE INDEX IF NOT EXISTS "inbound_emails_lead_id_idx" ON "inbound_emails"("lead_id");
