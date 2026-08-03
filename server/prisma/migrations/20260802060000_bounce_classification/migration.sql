-- Hard and soft bounces, told apart.
--
-- Every failed send was recorded identically: recipient `failed`, `bounced` true, error text
-- stored. That merges two situations a sender has to treat as opposites.
--
--   "550 no such user"        the mailbox does not exist and never will. Sending again is what
--                             costs a domain its reputation — mailbox providers score a sender on
--                             repeat attempts at addresses they have already rejected.
--   "451 greylisted"          the message was fine and the moment was not. Giving up loses a real
--   "452 mailbox full"        recipient for nothing.
--
-- So a hard bounce now suppresses the address (it joins the same list an unsubscribe writes to,
-- with reason `hard_bounce`), and a soft bounce stays queued and is attempted again on a backoff.
--
-- A third outcome matters as much as the other two: a failure at OUR end — expired SMTP password,
-- no connection — is neither. Those come back as 5xx and, read as hard bounces, would have put a
-- sender's entire audience on the suppression list in one bad afternoon.

-- hard | soft | unknown, as decided by src/campaigns/bounce-classifier.ts.
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "bounce_type" VARCHAR(8);

-- Attempts made for this recipient. Only a soft bounce increments it; the classifier's backoff
-- table caps the total, so a deferred recipient cannot be retried indefinitely.
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "retry_count" INTEGER NOT NULL DEFAULT 0;

-- When a deferred recipient may be tried again. NULL means "whenever the send reaches it", which
-- is the state every recipient starts in — so existing rows need no backfill.
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP(3);

-- The retry sweep runs once a minute and asks which deferred recipients are due. Without this it
-- answers by scanning every recipient row the brokerage has ever created.
CREATE INDEX IF NOT EXISTS "campaign_recipients_status_next_retry_at_idx"
  ON "campaign_recipients"("status", "next_retry_at");
