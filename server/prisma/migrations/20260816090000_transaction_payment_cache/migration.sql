-- Derived agent-payment figures, cached on `transactions`.
--
-- WHY. Every report that mentions payment state re-parsed the `admin_activities` TEXT blob for each
-- matching deal, on every request. Measured at 80,000 deals: Transaction Payment Status 10.3 s,
-- Sales Statement 4.0 s, brokerage totals 4.2 s -- the last dominated by a sequential scan calling
-- desk_safe_jsonb over ~40,000 wide rows, three times per request (once per commission variant).
--
-- NULLABLE, WITH NO DEFAULT, ON PURPOSE. NULL means "not computed yet", which readers treat as
-- "parse the blob" rather than as zero. That is what makes this migration safe to apply before the
-- backfill runs and before any code reads the columns: an un-backfilled row behaves exactly as it
-- does today. A DEFAULT 0 would have made "nothing paid" and "not computed" the same value.
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "calc_paid_total"       DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "calc_paid_date"        DATE,
  ADD COLUMN IF NOT EXISTS "calc_paid_name_count"  INTEGER,
  ADD COLUMN IF NOT EXISTS "calc_agent_name_count" INTEGER,
  ADD COLUMN IF NOT EXISTS "calc_faq_paid_status"  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "calc_at"               TIMESTAMP(0);

-- Finds the rows the recompute has not reached. Partial, because once the backfill has run this
-- index is empty and costs nothing to maintain -- which is the point: it exists to answer "is
-- anything stale?" cheaply, for ever, not to serve a report.
CREATE INDEX IF NOT EXISTS "transactions_calc_stale_idx"
  ON "transactions" ("id") WHERE "calc_at" IS NULL;
