-- Failed Google Calendar pushes become recoverable instead of disappearing.
--
-- WHAT WAS WRONG (CRM-GCAL-M01). `pushEvent`, `updateEvent` and `removeEvent` caught every failure,
-- logged a warning and returned. There is no Google scheduler, so nothing tried again; nothing on
-- the row said the mirror was behind; nothing on screen said so either. A viewing MOVED while Google
-- was briefly unreachable kept its old time on the agent's phone for ever — the exact failure
-- `updateEvent` was written to fix, reached by another route.
--
-- `last_synced_to_google` already existed and was stamped only on success, so the drift was
-- detectable in principle and read by nothing. These three columns make it actionable.
--
-- WHY NOT AN OUTBOX TABLE. The operation to retry is already derivable from the row — `deleted_at`
-- set means delete, no `google_calendar_id` means insert, otherwise patch — so a queue would
-- duplicate state that the event already holds, and would need its own reconciliation when the two
-- disagreed. Three columns on the row cannot disagree with the row.
ALTER TABLE "calendar_events"
  ADD COLUMN IF NOT EXISTS "google_sync_error" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "google_sync_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "google_sync_next_retry_at" TIMESTAMP(0);

-- The sweep's query: rows still owed to Google, due now. PARTIAL, because the overwhelming majority
-- of events have nothing outstanding and there is no reason to index them — this stays small even as
-- the table does not.
CREATE INDEX IF NOT EXISTS "calendar_events_google_retry_idx"
  ON "calendar_events" ("google_sync_next_retry_at")
  WHERE "google_sync_error" IS NOT NULL;
