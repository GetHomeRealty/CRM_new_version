-- One-off emails sent to a single lead from their own page.
--
-- Distinct from campaign_recipients, which belongs to a bulk send and carries open/unsubscribe
-- tracking. This is correspondence with one person: no pixel, no unsubscribe link, no audience.
--
-- Purely additive. Nothing existing is altered.

CREATE TABLE IF NOT EXISTS "lead_emails" (
  "id"         SERIAL PRIMARY KEY,
  "lead_id"    INTEGER      NOT NULL,
  "recipient"  VARCHAR(255) NOT NULL,
  "subject"    VARCHAR(255) NOT NULL,
  "body"       TEXT         NOT NULL,
  "status"     VARCHAR(16)  NOT NULL,
  "error"      VARCHAR(500),
  "account_id" INTEGER,
  "sent_by"    VARCHAR(255),
  "user_id"    INTEGER,
  "sent_at"    TIMESTAMP(0) NOT NULL,
  CONSTRAINT "lead_emails_lead_id_fkey" FOREIGN KEY ("lead_id")
    REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX IF NOT EXISTS "lead_emails_lead_id_idx" ON "lead_emails"("lead_id");
