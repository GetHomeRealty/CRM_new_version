-- Additive only. Existing messages remain explicitly unavailable for attachment/history content.
ALTER TABLE "inbound_emails" ADD COLUMN "attachments" JSONB;
ALTER TABLE "inbox_reply_submissions" ADD COLUMN "snapshot" JSONB;
CREATE INDEX "inbox_reply_submissions_user_status_updated_idx"
  ON "inbox_reply_submissions" ("user_id", "status", "updated_at" DESC);
