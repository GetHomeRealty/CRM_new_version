-- One Meta lead form belongs to one agent.
--
-- Each agent connects their own Meta account, their own Facebook Page and their own lead forms, and
-- receives their own leads. Nothing is shared. The table's existing key is
-- (user_id, form_id, page_id), which says "one row per agent per form" — and therefore permitted two
-- agents to connect the SAME form.
--
-- That was not theoretical. `ingestWebhookLead` resolved the owner with `findFirst` over that set,
-- so when it held two rows one agent received every delivery and the other received none, while
-- their screen showed the form as connected. The scheduled poll did reach both, which made the
-- symptom intermittent and the diagnosis harder than the bug.
--
-- WHY PARTIAL. Only `is_active` rows may claim a form. A form somebody connected and later turned
-- off must be free for whoever is running it now, and a full unique index would keep the dead row
-- holding the claim for ever.
--
-- WHY company_id IS IN THE KEY. Form ids come from Meta and are unique there, but the table carries
-- a tenant like every other, and a constraint that ignored it would let one brokerage's row block
-- another's — a cross-tenant failure that would be very hard to explain.

-- Refuse to migrate rather than silently drop somebody's connection. Any collision here is a real
-- configuration that has to be decided by a person: which agent keeps the form.
DO $$
DECLARE clashes bigint;
BEGIN
  SELECT count(*) INTO clashes FROM (
    SELECT 1 FROM "meta_lead_forms"
     WHERE "is_active"
     GROUP BY "company_id", "page_id", "form_id"
    HAVING count(*) > 1
  ) t;
  IF clashes > 0 THEN
    RAISE EXCEPTION
      'Refusing to migrate: % lead form(s) are connected by more than one agent. Decide who keeps each one and disconnect the others, then re-run. To list them: SELECT company_id, page_id, form_id, array_agg(user_id) FROM meta_lead_forms WHERE is_active GROUP BY 1,2,3 HAVING count(*) > 1;', clashes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "meta_lead_forms_page_form_key"
  ON "meta_lead_forms" ("company_id", "page_id", "form_id")
  WHERE "is_active";
