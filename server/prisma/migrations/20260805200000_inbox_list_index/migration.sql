-- The inbox list query, indexed for the way it is actually asked.
--
-- Every inbox read is `WHERE user_id = ? AND account_id = ? ORDER BY received_at DESC LIMIT 30`.
-- The table carried single-column indexes on `user_id`, `lead_id` and `company_id` and nothing that
-- helped the ORDER BY, so the planner filtered and then SORTED the whole matching set on every page
-- load. Measured 2026-08-05 with EXPLAIN over 2,265 rows:
--
--   Limit -> Sort (Sort Key: received_at DESC) -> Seq Scan on inbound_emails (Filter: user_id = 1)
--
-- At this size the sort is free and the seq scan is the right plan; the point is that the shape does
-- not improve as the table grows. A mailbox is append-only and one of the few tables here that grows
-- without bound — every message anybody receives, for ever — so this is the query whose plan matters
-- soonest.
--
-- TWO INDEXES, because `scopeFor` produces two different filters. When the area has a primary account
-- the read is by `account_id`; when it does not, the fallback is by `user_id` and the account's
-- scope. Each gets the leading column it filters on, with `received_at DESC` so the ORDER BY and the
-- LIMIT are satisfied by the index walk instead of a sort.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside the transaction Prisma wraps a
-- migration in. This table is small enough at present that the brief lock is not worth the extra
-- machinery; if that stops being true, build it by hand outside the migration and mark this applied.
CREATE INDEX IF NOT EXISTS "inbound_emails_user_id_received_at_idx"
  ON "inbound_emails" ("user_id", "received_at" DESC);

CREATE INDEX IF NOT EXISTS "inbound_emails_account_id_received_at_idx"
  ON "inbound_emails" ("account_id", "received_at" DESC);
