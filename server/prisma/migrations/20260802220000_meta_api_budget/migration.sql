-- A shared, app-wide ceiling on Graph calls.
--
-- The existing throttle on POST /api/meta/sync is keyed per user, which bounds one person and not
-- the brokerage — Meta's limits are per APP, so many agents together could still exhaust the
-- allowance and every one of them would see failures nobody could attribute.
--
-- One row per window. The increment is an INSERT ... ON CONFLICT DO UPDATE with a WHERE guard, so
-- the check and the increment are one atomic statement and two simultaneous syncs cannot both pass.
CREATE TABLE IF NOT EXISTS "meta_api_budget" (
  "id"           SERIAL       PRIMARY KEY,
  -- Epoch MILLISECONDS, not a timestamp. `timestamp without time zone` is written by the raw
  -- driver in local time and read back by Prisma as UTC, so the same window resolved to two
  -- different rows and the counter silently never incremented. An integer bucket has no timezone.
  "window_start" BIGINT       NOT NULL,
  "calls"        INTEGER      NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS "meta_api_budget_window_start_key" ON "meta_api_budget" ("window_start");
CREATE INDEX IF NOT EXISTS "meta_api_budget_window_start_idx" ON "meta_api_budget" ("window_start");

-- When a token dies, the agent is emailed once rather than every fifteen minutes for ever.
ALTER TABLE "meta_connections" ADD COLUMN IF NOT EXISTS "reconnect_notified_at" TIMESTAMP(0);
