-- Finish the move from "who is named on this deal" to "who owns this deal".
--
-- WHY THIS EXISTS. 20260803010000_person_user_ids added `transactions.agent_user_id` and
-- `team_members.user_id` and backfilled them, but AUTHORIZATION still compared
-- `transactions.agent` to `users.name`. A name is user-editable and not unique over time — this
-- database already holds two active accounts sharing one — so two namesakes could read and edit
-- each other's deals, and renaming somebody silently moved their access.
--
-- The application now decides ownership by id wherever the row carries one, and falls back to the
-- name only for rows that have no id (see server/src/common/transaction-scope.ts). That makes the
-- coverage of these two columns the thing that decides how much of the estate is protected, which
-- is what this migration is for: re-run the same resolution over everything written since, and
-- report what is left.
--
-- NO GUESSING, DELIBERATELY. A name matching two accounts is precisely the case that made the id
-- necessary, so choosing between them here would bake an arbitrary answer into the column the
-- application now trusts. Those rows are left NULL and keep resolving by name exactly as they do
-- today — no better, but no worse — and the NOTICE at the end names them so the brokerage can
-- assign them by hand.
--
-- ADDITIVE AND IDEMPOTENT. Nothing is dropped or renamed, only NULL columns are filled, and running
-- it twice changes nothing the second time.

DO $$
DECLARE
  filled_txn     integer;
  filled_member  integer;
  ambiguous_txn  integer;
  unmatched_txn  integer;
  ambiguous_mem  integer;
  unmatched_mem  integer;
  leftovers      text;
BEGIN
  -- Transactions: resolve the agent where the name matches exactly one account.
  UPDATE transactions t SET agent_user_id = u.id
  FROM users u
  WHERE t.agent_user_id IS NULL
    AND t.agent IS NOT NULL AND t.agent <> ''
    AND u.name = t.agent
    AND (SELECT count(*) FROM users x WHERE x.name = t.agent) = 1;
  GET DIAGNOSTICS filled_txn = ROW_COUNT;

  -- Team members: the same rule, because a split row grants access too.
  UPDATE team_members tm SET user_id = u.id
  FROM users u
  WHERE tm.user_id IS NULL
    AND tm.name IS NOT NULL AND tm.name <> ''
    AND u.name = tm.name
    AND (SELECT count(*) FROM users x WHERE x.name = tm.name) = 1;
  GET DIAGNOSTICS filled_member = ROW_COUNT;

  RAISE NOTICE 'agent_user_id: % transaction row(s) resolved; team_members.user_id: % row(s) resolved',
    filled_txn, filled_member;

  SELECT count(*) INTO ambiguous_txn FROM transactions t
   WHERE t.agent_user_id IS NULL AND t.agent IS NOT NULL AND t.agent <> ''
     AND (SELECT count(*) FROM users x WHERE x.name = t.agent) > 1;
  SELECT count(*) INTO unmatched_txn FROM transactions t
   WHERE t.agent_user_id IS NULL AND t.agent IS NOT NULL AND t.agent <> ''
     AND NOT EXISTS (SELECT 1 FROM users x WHERE x.name = t.agent);
  SELECT count(*) INTO ambiguous_mem FROM team_members tm
   WHERE tm.user_id IS NULL AND tm.name IS NOT NULL AND tm.name <> ''
     AND (SELECT count(*) FROM users x WHERE x.name = tm.name) > 1;
  SELECT count(*) INTO unmatched_mem FROM team_members tm
   WHERE tm.user_id IS NULL AND tm.name IS NOT NULL AND tm.name <> ''
     AND NOT EXISTS (SELECT 1 FROM users x WHERE x.name = tm.name);

  IF ambiguous_txn > 0 OR ambiguous_mem > 0 THEN
    -- The rows that still rely on the name, and are the ones a namesake can still reach. Named in
    -- full because there will be very few and somebody has to decide who they belong to.
    SELECT string_agg(DISTINCT agent, ', ') INTO leftovers
      FROM transactions t
     WHERE t.agent_user_id IS NULL AND t.agent IS NOT NULL AND t.agent <> ''
       AND (SELECT count(*) FROM users x WHERE x.name = t.agent) > 1;
    RAISE WARNING 'AMBIGUOUS OWNERS REMAIN — % transaction(s) and % team row(s) whose name matches more than one account: %. These keep resolving by name, so same-named users still share them. Assign them with:  UPDATE transactions SET agent_user_id = <id> WHERE id = <transaction id>;',
      ambiguous_txn, ambiguous_mem, COALESCE(leftovers, '-');
  END IF;

  IF unmatched_txn > 0 OR unmatched_mem > 0 THEN
    RAISE NOTICE 'No account matches the name on % transaction(s) and % team row(s) — historical staff, most likely. They stay on the name fallback and are visible to nobody unless an account with that exact name exists.',
      unmatched_txn, unmatched_mem;
  END IF;
END $$;
