-- A review decision is about a PERSON, not about a name.
--
-- WHY. `transaction_reviews` recorded the agent a decision concerned with `agent_name` alone, and
-- five things authorized on that string: the agent's review feed, their unread count, the
-- Notification Centre's review list, mark-as-seen, and the dashboard's open/corrected/overdue
-- figures. Two active accounts in this brokerage share a name. Those two people therefore received
-- each other's review items — and a review item carries the rejected FIELD, the REASON it was
-- rejected, and the OLD and NEW values. On a commission figure that is somebody else's pay.
--
-- Two more paths targeted by name and are corrected in the same change: the push notification about
-- a decision, and the SLA reminder that quotes the field and the reason. Both now resolve by id.
--
-- IDs AUTHORIZE. NAMES DISPLAY. `agent_name` is kept and is unchanged — it is a snapshot of what
-- the deal said when the decision was made, which is exactly what a historical record should hold,
-- and it still fills the reviewer's Agent filter, the stats grouping and the export column.
--
-- BACKFILLED FROM THE DEAL, not from the name. The review belongs to whoever owns the transaction,
-- and `transactions.agent_user_id` is already the resolved answer to that (migrations
-- 20260803010000 and 20260814090000). Copying it across means this column inherits the same
-- correctness rather than repeating the name-matching that caused the problem.
--
-- NOTHING IS GUESSED. A review whose transaction never resolved to an account is left NULL and
-- keeps the name fallback, behaving exactly as it does today — no better, no worse. The NOTICE
-- below counts them so somebody can decide, and the transaction-owner cleanup (see
-- 20260814090000_transaction_owner_ids) is what removes them: resolve the DEAL and re-run this
-- UPDATE, and its reviews resolve with it.

ALTER TABLE "transaction_reviews" ADD COLUMN IF NOT EXISTS "agent_user_id" INTEGER;

CREATE INDEX IF NOT EXISTS "transaction_reviews_agent_user_id_idx"
  ON "transaction_reviews" ("agent_user_id");

DO $$
DECLARE
  filled     integer;
  unresolved integer;
  affected   integer;
BEGIN
  UPDATE transaction_reviews r
     SET agent_user_id = t.agent_user_id
    FROM transactions t
   WHERE r.transaction_id = t.id
     AND r.agent_user_id IS NULL
     AND t.agent_user_id IS NOT NULL;
  GET DIAGNOSTICS filled = ROW_COUNT;
  RAISE NOTICE 'transaction_reviews.agent_user_id: % row(s) resolved from their transaction', filled;

  SELECT count(*) INTO unresolved FROM transaction_reviews WHERE agent_user_id IS NULL;
  SELECT count(DISTINCT transaction_id) INTO affected
    FROM transaction_reviews WHERE agent_user_id IS NULL;

  IF unresolved > 0 THEN
    RAISE WARNING 'ON THE NAME FALLBACK: % review row(s) across % transaction(s) whose deal has no resolved owner. Same-named agents can still see each other''s items on those. They resolve automatically once the DEAL is assigned — list them with:  SELECT DISTINCT r.transaction_id, t.trade_no, t.agent FROM transaction_reviews r JOIN transactions t ON t.id = r.transaction_id WHERE r.agent_user_id IS NULL;',
      unresolved, affected;
  END IF;
END $$;
