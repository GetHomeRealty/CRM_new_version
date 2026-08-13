-- Tell "hidden because Google was disconnected" apart from "the agent deleted this appointment".
--
-- THE DEFECT THIS CLOSES. Disconnecting Google Calendar removed the connection row and revoked the
-- token, and did nothing at all about the events that had been pulled from that calendar. They kept
-- their `deleted_at IS NULL` and every calendar query kept returning them — so an agent who
-- disconnected Google still saw their Google appointments, for ever, with no way to be rid of them
-- short of deleting each one by hand.
--
-- WHY THE FIX HIDES ROWS RATHER THAN FILTERING THEM AT READ TIME. `calendar_events` is read from
-- the calendar list, the single-event fetch, the conflict check, two dashboard tiles, the reminder
-- sweep, the iCal feed and the offboarding summary. Every one of those already filters
-- `deleted_at IS NULL`. Setting `deleted_at` therefore makes the events disappear from all of them
-- at once, with no query left to forget — where a read-time "is Google still connected?" predicate
-- would have had to be added to each, and would be silently wrong wherever it was missed.
--
-- WHY THIS COLUMN IS NEEDED AS WELL. `deleted_at` alone cannot answer the question reconnect has to
-- ask. On reconnect the pull sees the same Google events again and must restore the ones the
-- disconnect hid, while leaving alone the ones the agent genuinely deleted. Those two states are
-- indistinguishable in `deleted_at`. Without this marker the pull would have to choose between
-- resurrecting every event Google still lists — undoing real deletions in the case where the push
-- of that deletion to Google failed, which is best-effort and does fail — or resurrecting none,
-- which leaves a reconnected calendar permanently empty.
--
-- Additive and nullable: no existing row changes, and an application that does not know about the
-- column behaves exactly as it does today.

ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "google_disconnected_at" TIMESTAMP(0);

-- Partial, because the only question ever asked of this column is "which rows did a disconnect
-- hide?", and that is a small set against a table where almost every row has NULL here.
CREATE INDEX IF NOT EXISTS "calendar_events_google_disconnected_idx"
  ON "calendar_events" ("user_id", "google_disconnected_at")
  WHERE "google_disconnected_at" IS NOT NULL;
