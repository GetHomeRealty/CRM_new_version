-- Email to a candidate from Recruitment: the ones a recruiter sends by hand, and the automatic
-- reminder sent 24 hours before an interview.
--
-- ONE TABLE FOR BOTH, because both are the same thing to whoever reads the candidate's history:
-- a message that went (or did not go) to this person, with when, to which address, and why not.
--
-- `dedupe_key` IS THE DURABLE "ALREADY HANDLED" MARK for the automatic reminder:
--   interview-reminder-24h:<interview id>:<scheduled time, ISO>
-- Unique, so two overlapping sweeps or a restart mid-sweep cannot both send it — the second insert
-- fails. The scheduled time is part of the key, so moving the interview makes a new key and the old
-- one no longer matches anything. Null for a hand-sent email, which has no such duplicate to stop.
--
-- status: sending | sent | failed | skipped. `skipped` is a reminder that could not be attempted —
-- no email on file, or not a valid one — recorded so somebody can see why the candidate got none.
--
-- ON DELETE CASCADE from the candidate, like every other recruitment child table. The interview
-- reference is SET NULL: the row is history and outlives the interview it was about.

CREATE TABLE IF NOT EXISTS "recruitment_emails" (
  "id"              SERIAL        PRIMARY KEY,
  "candidate_id"    INTEGER       NOT NULL,
  "interview_id"    INTEGER,
  "kind"            VARCHAR(32)   NOT NULL,
  "dedupe_key"      VARCHAR(160),
  "status"          VARCHAR(16)   NOT NULL DEFAULT 'sending',
  "to_email"        VARCHAR(255),
  "from_email"      VARCHAR(255),
  "subject"         VARCHAR(255)  NOT NULL,
  "body"            TEXT          NOT NULL,
  "error_message"   VARCHAR(500),
  "attempts"        INTEGER       NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMP(0),
  "sent_at"         TIMESTAMP(0),
  "created_by"      VARCHAR(255),
  "user_id"         INTEGER,
  "created_at"      TIMESTAMP(0),
  "updated_at"      TIMESTAMP(0),

  CONSTRAINT "recruitment_emails_candidate_id_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "recruitment_emails_interview_id_fkey"
    FOREIGN KEY ("interview_id") REFERENCES "recruitment_interviews"("id")
    ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT "recruitment_emails_status_chk"
    CHECK ("status" IN ('sending', 'sent', 'failed', 'skipped')),
  CONSTRAINT "recruitment_emails_kind_chk"
    CHECK ("kind" IN ('manual', 'interview_reminder'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "recruitment_emails_dedupe_key_key" ON "recruitment_emails"("dedupe_key");
CREATE INDEX IF NOT EXISTS "recruitment_emails_candidate_id_idx" ON "recruitment_emails"("candidate_id");
CREATE INDEX IF NOT EXISTS "recruitment_emails_interview_id_idx" ON "recruitment_emails"("interview_id");
CREATE INDEX IF NOT EXISTS "recruitment_emails_status_idx" ON "recruitment_emails"("status");

-- WHEN THE CURRENT INTERVIEW TIME WAS SET — on booking, and again whenever it is moved. The 24-hour
-- reminder is sent only for an interview whose time was set at least 24 hours before it, so an
-- interview booked (or moved) for tomorrow morning does not get a late "24-hour" reminder.
--
-- Backfilled from the row's last change, which is never earlier than the real moment the time was
-- set. The error runs one way only: an existing interview edited for some other reason inside the
-- final 24 hours is treated as booked late and gets no reminder — never a late one.
ALTER TABLE "recruitment_interviews" ADD COLUMN IF NOT EXISTS "scheduled_set_at" TIMESTAMP(0);
UPDATE "recruitment_interviews"
   SET "scheduled_set_at" = COALESCE("updated_at", "created_at", CURRENT_TIMESTAMP)
 WHERE "scheduled_set_at" IS NULL;
