-- EMAIL ABOUT A LEAD TASK: the creator's confirmation, the assigned agent's notice, or one combined
-- message when they are the same person.
--
-- AN OUTBOX, WRITTEN IN THE SAME TRANSACTION AS THE TASK. A row exists only if the task (or the
-- reassignment) committed, so a rolled-back save can never be announced. Delivery happens after the
-- commit, in the background, and its outcome is written back here — so a failed delivery is a row
-- somebody can find and retry rather than a line in a log.
--
-- `dedupe_key` IS THE "ALREADY QUEUED" MARK, unique, so a repeated request or a retried job cannot
-- queue the same message twice:
--   task-created:<task>:<creator>                     creator's confirmation
--   task-created-assigned:<task>:<creator>            combined, creator is also the agent
--   task-assigned:<task>:<assignment n>:<agent>       agent's notice; n counts real changes
--
-- status: pending | sending | sent | failed | skipped
--   pending  queued, or waiting for its next retry at `next_attempt_at`
--   sending  claimed by one process; a row stuck here was interrupted mid-send (outcome unknown)
--   skipped  never attempted — no valid address, inactive account, muted, template switched off
--
-- ON DELETE CASCADE from the task: a deleted task takes its unsent mail with it.

CREATE TABLE IF NOT EXISTS "lead_task_notifications" (
  "id"                SERIAL        PRIMARY KEY,
  "task_id"           INTEGER       NOT NULL,
  "lead_id"           INTEGER       NOT NULL,
  "kind"              VARCHAR(24)   NOT NULL,
  "recipient_user_id" INTEGER       NOT NULL,
  "actor_user_id"     INTEGER,
  "dedupe_key"        VARCHAR(190)  NOT NULL,
  "status"            VARCHAR(16)   NOT NULL DEFAULT 'pending',
  "to_email"          VARCHAR(255),
  "subject"           VARCHAR(255),
  "error_message"     VARCHAR(500),
  "attempts"          INTEGER       NOT NULL DEFAULT 0,
  "next_attempt_at"   TIMESTAMP(0),
  "last_attempt_at"   TIMESTAMP(0),
  "sent_at"           TIMESTAMP(0),
  "created_at"        TIMESTAMP(0)  NOT NULL,
  "updated_at"        TIMESTAMP(0)  NOT NULL,

  CONSTRAINT "lead_task_notifications_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "lead_tasks"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "lead_task_notifications_status_chk"
    CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  CONSTRAINT "lead_task_notifications_kind_chk"
    CHECK ("kind" IN ('created', 'assigned', 'created_assigned'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "lead_task_notifications_dedupe_key_key" ON "lead_task_notifications"("dedupe_key");
CREATE INDEX IF NOT EXISTS "lead_task_notifications_task_id_idx" ON "lead_task_notifications"("task_id");
CREATE INDEX IF NOT EXISTS "lead_task_notifications_lead_id_idx" ON "lead_task_notifications"("lead_id");
CREATE INDEX IF NOT EXISTS "lead_task_notifications_status_next_attempt_at_idx" ON "lead_task_notifications"("status", "next_attempt_at");

-- LET THE APPLICATION USE IT. Migrations run as the owner while the app connects as its own user,
-- and there are no default privileges, so a new table is unreadable to the app until granted (the
-- lesson of 20261019130000_payment_sheet_rows_access). Granted to exactly whoever can already use
-- lead_tasks, plus its owner when that is not postgres. Re-running it changes nothing.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee AS role FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'lead_tasks' AND privilege_type = 'SELECT'
       AND grantee NOT IN ('postgres', 'PUBLIC')
    UNION
    SELECT tableowner FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'lead_tasks' AND tableowner <> 'postgres'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lead_task_notifications TO %I', r.role);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.lead_task_notifications_id_seq TO %I', r.role);
  END LOOP;
END $$;
