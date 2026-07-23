-- Read-only Google Calendar subscription by secret iCal URL (the no-OAuth connect option).
-- One per user. Additive.

CREATE TABLE IF NOT EXISTS "ical_feeds" (
  "id"         SERIAL PRIMARY KEY,
  "user_id"    INTEGER NOT NULL UNIQUE,
  "url"        TEXT    NOT NULL,
  "name"       VARCHAR(255),
  "last_sync"  TIMESTAMP(0),
  "sync_error" VARCHAR(500),
  "created_at" TIMESTAMP(0),
  "updated_at" TIMESTAMP(0)
);

CREATE INDEX IF NOT EXISTS "ical_feeds_user_id_idx" ON "ical_feeds"("user_id");
