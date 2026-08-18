-- Server-side idempotency for campaign creation.
--
-- ================================================================================================
-- WHAT THIS FIXES. Creating and sending a campaign had no duplicate protection on the server. The
-- only thing preventing a double submission was the builder's `disabled={sending}` attribute, and
-- removing it during the CRM audit produced two scheduled campaigns of eighteen recipients each,
-- identical in name, template, audience and scheduled time.
--
-- A duplicate campaign is not an untidy row. It is every recipient receiving the same message twice,
-- which is the failure a campaign tool most needs to avoid — and a disabled button is defeated by a
-- network retry, a replayed request, a second tab, or a direct call to the API.
--
-- Leads were never exposed to this because `leads_owner_email_key` catches a repeat in the database.
-- Campaigns have no natural key of that kind: two campaigns with the same name, template and
-- audience are a perfectly legitimate thing to want a week apart. So the client names the ATTEMPT,
-- and the server refuses to perform the same named attempt twice.
-- ================================================================================================
--
-- SCOPED TO THE CREATOR RATHER THAN GLOBALLY UNIQUE. The key comes from the client, so a globally
-- unique index would let anyone replay a key they guessed or observed and be handed back the
-- campaign it belongs to. Keying on (created_by_id, idempotency_key) means a replay can only ever be
-- answered to the account that made the original.
--
-- NULLS ARE NOT EQUAL IN POSTGRESQL, which is exactly what is wanted here: every existing campaign
-- has a NULL key, and any number of NULLs coexist under a unique index. A caller that sends no key
-- is simply not de-duplicated, which is the behaviour that was there before.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_creator_idempotency_key
  ON campaigns (created_by_id, idempotency_key);
