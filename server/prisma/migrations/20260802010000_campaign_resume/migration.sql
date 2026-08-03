-- Make an interrupted campaign resumable.
--
-- A send used to be recoverable only in the sense that the counters were accurate: a restart left
-- the campaign `partial` and the remaining recipients unsent, with no way to continue that did not
-- risk emailing everyone a second time. Almost everything needed was already on the row —
-- template_id, subject, content, created_by_id — and campaign_recipients already carries email,
-- name, token and status. These two columns close the gap.

-- Where the tracking pixel and unsubscribe links point. Stored per campaign rather than read from
-- the environment at resume time, because a message already sent carries the URL it was built
-- with; the remainder of the same campaign must match it, even if the setting has since changed.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "tracking_base_url" VARCHAR(500);

-- The resolved personalisation values for this recipient, as JSON. Re-deriving them at resume
-- would mean re-reading the lead, which may have been edited — or deleted — since the send began,
-- so the second half of a campaign could address someone differently from the first.
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "vars" TEXT;

-- Finding the interrupted ones at boot. Without this the recovery sweep scans every campaign the
-- brokerage has ever sent, on every restart.
CREATE INDEX IF NOT EXISTS "campaigns_status_idx" ON "campaigns"("status");
