-- Identify people by id, not by the name they happen to have today.
--
-- WHY. Commission splits, agent emails and campaign attribution all resolve a person with
-- `users.findFirst({ where: { name } })`. A name is user-editable and not unique over time, so the
-- lookup is ambiguous by construction — and `findFirst` without an `orderBy` has no defined order.
-- Measured in the Users audit (U-C1): a deactivated agent on a 10% split and an active namesake on
-- 90% resolved, three times out of three, to the INACTIVE row. Every deal the new agent closed
-- would have paid the departed colleague's percentage.
--
-- The Users module now refuses to create a second row with the same name, which stops NEW
-- occurrences. This closes the underlying design: the id is written alongside the name, and the
-- resolvers prefer it.
--
-- ADDITIVE AND REVERSIBLE ON PURPOSE. Nothing is dropped, nothing is renamed, and the name columns
-- keep their values — they are still what the screens display and what older rows carry. The new
-- columns are nullable, so a row whose name cannot be resolved simply keeps working the way it
-- always did, through the name fallback.

ALTER TABLE "transactions"       ADD COLUMN IF NOT EXISTS "agent_user_id"      INTEGER;
ALTER TABLE "team_members"       ADD COLUMN IF NOT EXISTS "user_id"            INTEGER;

-- Campaigns are deliberately NOT touched: campaigns.created_by_id and campaign_templates.user_id
-- already exist and are already written by the campaigns service, so attribution there is id-based
-- today. Only the varchar name beside them is legacy display data.

CREATE INDEX IF NOT EXISTS "transactions_agent_user_id_idx"       ON "transactions" ("agent_user_id");
CREATE INDEX IF NOT EXISTS "team_members_user_id_idx"             ON "team_members" ("user_id");

-- Backfill ONLY where the name resolves to exactly one user.
--
-- A name matching two accounts is precisely the case that made this necessary, so guessing between
-- them here would bake the wrong answer into a column that is then trusted. Those rows are left
-- NULL and keep resolving by name exactly as before — no better, but no worse — and the NOTICE at
-- the end says how many there are so somebody can decide.
DO $$
DECLARE
  filled integer;
  ambiguous integer;
  unmatched integer;
BEGIN
  UPDATE transactions t SET agent_user_id = u.id
  FROM users u
  WHERE t.agent_user_id IS NULL
    AND t.agent IS NOT NULL AND t.agent <> ''
    AND u.name = t.agent
    AND (SELECT count(*) FROM users x WHERE x.name = t.agent) = 1;
  GET DIAGNOSTICS filled = ROW_COUNT;
  RAISE NOTICE 'transactions.agent_user_id: % row(s) resolved', filled;

  UPDATE team_members tm SET user_id = u.id
  FROM users u
  WHERE tm.user_id IS NULL
    AND tm.name IS NOT NULL AND tm.name <> ''
    AND u.name = tm.name
    AND (SELECT count(*) FROM users x WHERE x.name = tm.name) = 1;
  GET DIAGNOSTICS filled = ROW_COUNT;
  RAISE NOTICE 'team_members.user_id: % row(s) resolved', filled;

  -- What could not be resolved, so it is visible rather than silently left behind.
  SELECT count(*) INTO ambiguous FROM transactions t
   WHERE t.agent_user_id IS NULL AND t.agent IS NOT NULL AND t.agent <> ''
     AND (SELECT count(*) FROM users x WHERE x.name = t.agent) > 1;
  SELECT count(*) INTO unmatched FROM transactions t
   WHERE t.agent_user_id IS NULL AND t.agent IS NOT NULL AND t.agent <> ''
     AND NOT EXISTS (SELECT 1 FROM users x WHERE x.name = t.agent);

  IF ambiguous > 0 OR unmatched > 0 THEN
    RAISE NOTICE 'transactions left on the name fallback: % ambiguous (name matches more than one user), % unmatched (no user with that name). List them with:  SELECT DISTINCT agent FROM transactions WHERE agent_user_id IS NULL AND agent <> '''';', ambiguous, unmatched;
  END IF;
END $$;
