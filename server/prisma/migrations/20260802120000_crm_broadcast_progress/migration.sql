-- Staff broadcasts, delivered off the request thread.
--
-- `broadcast()` sent one SMTP message per active user, awaited in turn, INSIDE the HTTP request.
-- That is the same shape the Campaigns module already removed for the same reason: at a few hundred
-- staff it runs past the browser's patience and past the 300 s proxy_read_timeout in the deployment
-- guide, and a timeout mid-loop leaves some people emailed and some not with the count written only
-- if the loop reached the end. The brokerage this is built for has hundreds of agents.
--
-- The row is now written first, returned immediately, and delivered detached — which needs somewhere
-- to record how far it got.

-- sending | completed | partial | failed. Existing rows finished before this column existed, so
-- `completed` is the honest default for them and the service sets `sending` explicitly on new ones.
ALTER TABLE "crm_broadcasts" ADD COLUMN IF NOT EXISTS "status" VARCHAR(16) NOT NULL DEFAULT 'completed';

-- How many addresses the send is working through, so `recipients` (delivered so far) means something
-- while it is in flight rather than only at the end.
ALTER TABLE "crm_broadcasts" ADD COLUMN IF NOT EXISTS "attempted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "crm_broadcasts" ADD COLUMN IF NOT EXISTS "failed" INTEGER NOT NULL DEFAULT 0;

-- The first failure. A broadcast that reached nobody used to return the same cheerful message as one
-- that reached everyone; now that the request returns before delivery, the reason has to live on the
-- row where the screen can read it back.
ALTER TABLE "crm_broadcasts" ADD COLUMN IF NOT EXISTS "error" TEXT;

ALTER TABLE "crm_broadcasts" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP(0);

-- Backfill: everything that already exists finished synchronously, so its delivered count is also
-- its attempted count and its completion time is when it was created.
UPDATE "crm_broadcasts"
   SET "attempted" = "recipients",
       "completed_at" = COALESCE("completed_at", "created_at")
 WHERE "attempted" = 0;
