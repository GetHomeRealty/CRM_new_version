-- One person may be a lead more than once. Uniqueness moves from global to per owner.
--
-- WHAT WAS WRONG WITH GLOBAL. `leads_email_lower_key` was UNIQUE on lower(email) across every row
-- in the database, which encoded an assumption nobody had agreed to: that an email address belongs
-- to exactly one lead, for ever, anywhere. Real intake does not work that way.
--
--   * A person clicks BROKERAGE A's Facebook ad on Monday and BROKERAGE B's on Thursday. Both
--     brokerages have a genuine, independently-consented relationship with them. Under a global
--     index the second brokerage's Meta webhook silently reported "already existed" and the lead
--     was never created — a paid click, thrown away, with nothing on any screen to say so.
--   * The same happens inside ONE brokerage. A referral reaches agent 1; the same person later
--     fills in agent 2's landing page. Agent 2 is entitled to work that relationship — the CRM's
--     whole model is that a book belongs to the agent — but the create form refused them, and the
--     only remedy was to ask an administrator to reassign a colleague's lead.
--
-- WHAT REPLACES IT. UNIQUE (company_id, COALESCE(owner_user_id, 0), lower(email)):
--
--   * different brokerage        -> allowed  (company_id differs)
--   * different agent, same firm -> allowed  (owner_user_id differs)
--   * SAME agent, same address   -> refused  (this is the case the constraint exists for: one
--                                             person must not appear twice in one book, splitting
--                                             their history and double-sending every campaign)
--
-- WHY COALESCE AND NOT A PLAIN THREE-COLUMN UNIQUE. Postgres treats NULLs as distinct in a unique
-- index, so an unowned row would be exempt from the constraint entirely — and `owner_user_id IS
-- NULL` is exactly what unattributed brokerage intake looks like, the highest-volume source there
-- is. Without the COALESCE, a Meta form or an import that forgot to stamp an owner could pile up
-- unlimited copies of one address, which is the failure this constraint exists to prevent.
-- Postgres 15's NULLS NOT DISTINCT would also work; COALESCE does not require it, and this database
-- has to be restorable onto whatever the host provides. 0 is safe as the sentinel: users.id is a
-- positive identity column, so no real owner can collide with it.

-- Verified empty on the development database before writing this. Left in deliberately: it turns a
-- migration that would corrupt data into one that refuses to run, on any database it is applied to.
DO $$
DECLARE clashes bigint;
BEGIN
  SELECT count(*) INTO clashes FROM (
    SELECT 1 FROM leads
     GROUP BY company_id, COALESCE(owner_user_id, 0), lower(email)
    HAVING count(*) > 1
  ) t;
  IF clashes > 0 THEN
    RAISE EXCEPTION
      'Refusing to migrate: % address(es) already appear twice in the same book. Merge or reassign them first — SELECT company_id, owner_user_id, lower(email), count(*) FROM leads GROUP BY 1,2,3 HAVING count(*) > 1;', clashes;
  END IF;
END $$;

DROP INDEX IF EXISTS "leads_email_lower_key";

CREATE UNIQUE INDEX IF NOT EXISTS "leads_company_owner_email_key"
  ON "leads" ("company_id", COALESCE("owner_user_id", 0), LOWER("email"));

-- The import and the duplicate check both look an address up within one book, which is a prefix of
-- the unique index above, so it serves them. This second index covers the OTHER question the module
-- asks constantly — "is this address anywhere in the brokerage?" — which the old global index used
-- to answer and no longer can.
CREATE INDEX IF NOT EXISTS "leads_company_email_lower_idx"
  ON "leads" ("company_id", LOWER("email"));
