-- A commission change REQUEST carries the numbers it is asking for, not just permission to type.
--
-- WHY THE TABLE NEEDED ANYTHING NEW. `transaction_edit_requests` has always meant "let me edit this
-- locked deal": approving it unlocks the fields and the requester then types the values themselves.
-- A commission change is a different shape of the same workflow — the requester proposes the
-- numbers, a Super Admin sees exactly what is being asked for, and approving APPLIES it. That
-- needs somewhere to keep the proposal, which no column held.
--
-- `proposed`  the values being asked for. Only the keys actually being changed.
-- `baseline`  the same keys as they stood when the request was made.
--
-- BASELINE EARNS ITS PLACE TWICE, which is why it is stored rather than re-read at review time:
--
--   1. The reviewer is shown old-versus-proposed. Reading "old" live would show whatever the deal
--      says NOW, so a figure changed after the request was raised would be presented as the value
--      the requester saw — the reviewer would approve a comparison that never existed.
--
--   2. It is how a stale request is caught. If the live values no longer match `baseline`, the
--      commission moved under the request and applying it would silently revert somebody else's
--      newer change. Approval refuses instead.
--
-- BOTH NULLABLE AND ADDITIVE. Every existing row is an ordinary unlock request and stays exactly
-- that: null here means "no proposal", which is the behaviour the table had before this column.
-- Nothing that currently writes a request mentions either column.
ALTER TABLE "transaction_edit_requests"
  ADD COLUMN IF NOT EXISTS "proposed" JSONB,
  ADD COLUMN IF NOT EXISTS "baseline" JSONB;
