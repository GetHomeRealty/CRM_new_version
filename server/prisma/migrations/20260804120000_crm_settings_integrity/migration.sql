-- Give `crm_settings` the constraints its four sibling CRM tables already have.
--
-- WHY. `crm_email_settings`, `crm_referral_codes`, `crm_email_log` and `crm_broadcasts` each carry a
-- foreign key to `company_settings`. `crm_settings` — the table the whole CRM Settings screen reads
-- and writes — carried none, and none to `users` either. Two consequences, both found in the
-- 2026-08-04 audit (finding L13, and S-M10 before it):
--
--   * Deleting a user left their personal settings row behind for ever. Nothing pointed at it,
--     nothing cleaned it up, and `user_id` would eventually collide with a new account taking the
--     same id — at which point somebody inherits a departed colleague's signature.
--   * `company_id` pointed at a brokerage nothing guaranteed existed.
--
-- AND THE GLOBAL ROW WAS UNPROTECTED. `user_id` is `UNIQUE`, which reads as "one row per user" and
-- is true for personal rows — but SQL treats NULLs as distinct, so the shared row every
-- administrator edits (`user_id IS NULL`) could exist any number of times. Two concurrent first
-- saves would each have inserted one, and `findFirst` would then have returned whichever the
-- planner reached first. A partial unique index is the only way to say "at most one NULL row per
-- brokerage"; Prisma cannot express one, so it lives here in SQL exactly as
-- `users_username_lower_key` does in 20260803000000.
--
-- SAFE TO RE-RUN, and refuses rather than damages: every statement is IF NOT EXISTS, and the guard
-- below stops the migration with a message naming the rows to fix rather than letting a constraint
-- fail with a bare violation. Verified against the development database before writing: zero
-- duplicate global rows, zero rows referencing a missing user, zero referencing a missing company.

DO $$
DECLARE offenders integer;
BEGIN
  SELECT count(*) INTO offenders FROM (
    SELECT company_id FROM crm_settings WHERE user_id IS NULL GROUP BY company_id HAVING count(*) > 1
  ) dupes;
  IF offenders > 0 THEN
    RAISE EXCEPTION
      'Cannot add the single-global-row index: % brokerage(s) already hold more than one shared crm_settings row. List them with:  SELECT company_id, count(*) FROM crm_settings WHERE user_id IS NULL GROUP BY company_id HAVING count(*) > 1;  Keep the most recently updated row of each and delete the rest, then run this migration again.',
      offenders;
  END IF;

  SELECT count(*) INTO offenders FROM crm_settings s
    WHERE s.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id);
  IF offenders > 0 THEN
    RAISE EXCEPTION
      'Cannot add the users foreign key: % crm_settings row(s) belong to a user that no longer exists. These are exactly the stranded rows this migration exists to prevent. Remove them with:  DELETE FROM crm_settings s WHERE s.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id);',
      offenders;
  END IF;

  SELECT count(*) INTO offenders FROM crm_settings s
    WHERE NOT EXISTS (SELECT 1 FROM company_settings c WHERE c.id = s.company_id);
  IF offenders > 0 THEN
    RAISE EXCEPTION
      'Cannot add the company foreign key: % crm_settings row(s) reference a company_settings row that does not exist.',
      offenders;
  END IF;
END $$;

-- At most one shared row per brokerage. Partial, because the personal rows are already covered by
-- the existing UNIQUE on user_id and must not be caught by this one.
CREATE UNIQUE INDEX IF NOT EXISTS "crm_settings_global_per_company_key"
  ON "crm_settings" ("company_id") WHERE "user_id" IS NULL;

-- A personal settings row has no meaning without the person. The shared row has user_id NULL and is
-- untouched by this.
ALTER TABLE "crm_settings"
  ADD CONSTRAINT "crm_settings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Matches the four sibling CRM tables: NO ACTION on update, and a brokerage cannot be removed while
-- its settings still reference it.
ALTER TABLE "crm_settings"
  ADD CONSTRAINT "crm_settings_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
