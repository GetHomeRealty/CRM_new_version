-- Google Calendar OAuth connections, one per user. Tokens are stored encrypted by the app.
-- Additive; the calendar_events table already carries google_calendar_id / last_synced_to_google.

CREATE TABLE IF NOT EXISTS "google_connections" (
  "id"               SERIAL PRIMARY KEY,
  "user_id"          INTEGER      NOT NULL UNIQUE,
  "google_email"     VARCHAR(320),
  "access_token"     TEXT,
  "refresh_token"    TEXT,
  "token_expires_at" TIMESTAMP(0),
  "scopes"           TEXT,
  "calendar_id"      VARCHAR(255) NOT NULL DEFAULT 'primary',
  "sync_token"       TEXT,
  "last_sync"        TIMESTAMP(0),
  "connect_error"    VARCHAR(500),
  "is_active"        BOOLEAN      NOT NULL DEFAULT true,
  "created_at"       TIMESTAMP(0),
  "updated_at"       TIMESTAMP(0)
);

CREATE INDEX IF NOT EXISTS "google_connections_user_id_idx" ON "google_connections"("user_id");
