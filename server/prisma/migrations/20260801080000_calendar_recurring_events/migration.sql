-- Recurring appointments: a weekly team meeting, a Saturday open house, a monthly review.
--
-- WHY THE OCCURRENCES ARE REAL ROWS. Every other part of the calendar already reads
-- `calendar_events`: the reminder sweep, the Google push, the overlap check, the month query.
-- Expanding a rule at read time would mean teaching all four about recurrence, and any one of them
-- forgetting would silently drop a reminder or double-book a slot. Materialising the occurrences
-- means none of them change at all -- an occurrence is simply an event, and everything that already
-- works on events works on it.
--
-- The cost is rows, which is why generation is bounded (see RECURRENCE_MAX_OCCURRENCES): a rule with
-- no end still stops at a horizon rather than filling the table.

-- The series a row belongs to. NULL for a one-off. For a series this is the id of the FIRST
-- occurrence, which is also the row that carries the rule -- so the parent points at itself and
-- there is no separate "series" table to keep in step.
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "recurrence_id" INTEGER;

-- The rule, only ever set on the first occurrence. daily | weekly | monthly.
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "recur_freq"     VARCHAR(10);
-- Every N days/weeks/months. 1 unless stated.
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "recur_interval" INTEGER;
-- The last day an occurrence may fall on. NULL with a count, or open-ended to the horizon.
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "recur_until"    DATE;
-- How many occurrences in total, including the first. NULL when an end date is used instead.
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "recur_count"    INTEGER;

-- Fetching or editing a whole series is the common operation, and every occurrence carries the id.
CREATE INDEX IF NOT EXISTS "calendar_events_recurrence_idx" ON "calendar_events" ("recurrence_id");

-- Deleting the first occurrence must not orphan the rest, so the link is set null rather than
-- cascading: the remaining occurrences survive as ordinary events, which is the honest outcome --
-- an appointment somebody scheduled does not vanish because the series head was removed.
DO $$
BEGIN
    ALTER TABLE "calendar_events"
        ADD CONSTRAINT "calendar_events_recurrence_fk"
        FOREIGN KEY ("recurrence_id") REFERENCES "calendar_events"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
