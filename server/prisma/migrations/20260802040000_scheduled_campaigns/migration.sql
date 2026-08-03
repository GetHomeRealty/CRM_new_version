-- Scheduled campaign sends.
--
-- Agents write copy when they have time, which is rarely when the message should go out — Tuesday
-- morning beats Friday evening, and nobody is at their desk for either. Until now the only option
-- was "send now", so the send time was whenever the author happened to finish.
--
-- Stored as an absolute instant (timestamptz semantics via Timestamp(3) + UTC in the app), not as
-- a local wall-clock string: the brokerage is in Toronto and crosses DST twice a year, and a
-- campaign scheduled as "09:00" either side of a transition would otherwise move by an hour.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "scheduled_for" TIMESTAMP(3);

-- Who scheduled it, so a campaign that fires days later still sends from the right account and
-- carries the right agent tokens. created_by_id already records this, but a scheduled campaign is
-- the case where it MUST be present rather than merely useful.
CREATE INDEX IF NOT EXISTS "campaigns_scheduled_for_idx" ON "campaigns"("scheduled_for");
