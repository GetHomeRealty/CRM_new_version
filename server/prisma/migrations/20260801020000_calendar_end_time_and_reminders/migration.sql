-- Calendar events gain an end time, and appointment reminders gain somewhere to record themselves.
--
-- end_time is nullable on purpose. Every one of the events already in this table was created
-- without one, and inventing a duration for an appointment nobody timed would be a guess written
-- into the record. Null means "no end recorded"; the conflict check treats such an event as the
-- one-hour block the Google push has always assumed, and says so to the user.
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "end_time" VARCHAR(8);

-- Which appointment reminders have gone out, so a reminder is sent once and only once.
-- reminder_sent on calendar_events records only "something was sent"; it cannot express which
-- lead time it was for, so a 24-hour and a 1-hour reminder for the same event would collide on it.
CREATE TABLE IF NOT EXISTS "calendar_event_reminders" (
    "id"                SERIAL       PRIMARY KEY,
    "calendar_event_id" INTEGER      NOT NULL,
    "lead_minutes"      INTEGER      NOT NULL,
    "delivery_status"   VARCHAR(16)  NOT NULL DEFAULT 'Pending',
    "attempts"          INTEGER      NOT NULL DEFAULT 0,
    "next_retry_at"     TIMESTAMP(3),
    "detail"            TEXT,
    "sent_to"           VARCHAR(255),
    "sent_at"           TIMESTAMP(3),
    "company_id"        INTEGER      NOT NULL DEFAULT 1,
    "created_at"        TIMESTAMP(3),
    "updated_at"        TIMESTAMP(3)
);

-- The idempotency key. One row per (event, lead time) and no more, so a sweep that runs twice --
-- two app instances, a restart mid-pass, a manual re-run -- inserts nothing the second time and
-- nobody is emailed about the same appointment twice.
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_event_reminders_event_lead_key"
    ON "calendar_event_reminders" ("calendar_event_id", "lead_minutes");

CREATE INDEX IF NOT EXISTS "calendar_event_reminders_status_idx"
    ON "calendar_event_reminders" ("delivery_status");
CREATE INDEX IF NOT EXISTS "calendar_event_reminders_retry_idx"
    ON "calendar_event_reminders" ("next_retry_at");
CREATE INDEX IF NOT EXISTS "calendar_event_reminders_company_idx"
    ON "calendar_event_reminders" ("company_id");

DO $$
BEGIN
    ALTER TABLE "calendar_event_reminders"
        ADD CONSTRAINT "calendar_event_reminders_event_fk"
        FOREIGN KEY ("calendar_event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The month grid asks for one month at a time now, so the list query filters on (user, date)
-- rather than reading the user's whole history and filtering it in the browser.
CREATE INDEX IF NOT EXISTS "calendar_events_user_date_idx"
    ON "calendar_events" ("user_id", "date");
