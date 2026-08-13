-- CRM email triggers become one person's own, and the Triggers screen gets a permission that means
-- something.
--
-- WHY. Triggers lived in the single brokerage-wide `crm_email_settings` row, so one agent switching
-- off promotional email switched it off for the whole office — and the Triggers screen, which shows
-- nothing but switches, posted the shared SMTP fields back with every save, silently reverting
-- changes an administrator had made on a different screen (CRM › Triggers audit, findings T-H1 and
-- T-H2).
--
-- Both problems come from one table doing two jobs. This separates them:
--
--   crm_email_settings    stays brokerage-wide — SMTP reference details, the `auto_send_enabled`
--                         kill switch, and `template_toggles` as the DEFAULT a new user inherits.
--   crm_trigger_settings  one row per person, holding only that person's toggles.
--
-- A user with no row here inherits the brokerage default, so nobody's behaviour changes on the day
-- this runs. Nothing is copied down into per-user rows on purpose: pre-seeding would freeze every
-- agent at today's defaults and make a later change to the brokerage default invisible to them.

CREATE TABLE IF NOT EXISTS "crm_trigger_settings" (
  "id"               SERIAL       PRIMARY KEY,
  "user_id"          INTEGER      NOT NULL,
  "template_toggles" TEXT,
  "updated_by"       VARCHAR(255),
  "created_at"       TIMESTAMP(0),
  "updated_at"       TIMESTAMP(0),
  "company_id"       INTEGER      NOT NULL DEFAULT 1
);

-- One row per person. The unique is what makes "your triggers" a single answerable question.
CREATE UNIQUE INDEX IF NOT EXISTS "crm_trigger_settings_user_id_key"
  ON "crm_trigger_settings" ("user_id");
CREATE INDEX IF NOT EXISTS "crm_trigger_settings_company_id_idx"
  ON "crm_trigger_settings" ("company_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_trigger_settings_user_id_fkey') THEN
    ALTER TABLE "crm_trigger_settings"
      ADD CONSTRAINT "crm_trigger_settings_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_trigger_settings_company_id_fkey') THEN
    ALTER TABLE "crm_trigger_settings"
      ADD CONSTRAINT "crm_trigger_settings_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- T-M8: one settings row per brokerage, the constraint `crm_settings` was given yesterday and this
-- sibling was not. Two concurrent first-saves on an empty table could otherwise create two rows,
-- after which `findFirst` would silently govern from one while the other took the writes.
DO $$
DECLARE offenders integer;
BEGIN
  SELECT count(*) INTO offenders FROM (
    SELECT company_id FROM crm_email_settings GROUP BY company_id HAVING count(*) > 1
  ) dupes;
  IF offenders > 0 THEN
    RAISE EXCEPTION
      'Cannot add the one-row-per-brokerage index: % brokerage(s) already hold more than one crm_email_settings row. List them with:  SELECT company_id, count(*) FROM crm_email_settings GROUP BY company_id HAVING count(*) > 1;  Keep the most recently updated row of each and delete the rest, then run this migration again.',
      offenders;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "crm_email_settings_company_id_key"
  ON "crm_email_settings" ("company_id");

-- ---------------------------------------------------------------------------------------------
-- T-H1: the Triggers screen is offered to every role and, until now, worked for two.
--
-- The route and the sidebar ask for `triggers`, which every role holds. The screen behind them
-- asked for `settings`, which agent, accounting, documentation and crm do not — so four roles were
-- invited to a screen that then refused them. The screen now asks for `triggers` like everything
-- else pointing at it, and the roles that manage their own triggers are granted `triggers.edit`.
--
-- Agent and CRM are raised from view to edit: with triggers now personal, choosing which CRM emails
-- you send is your own decision and cannot reach anyone else's account. Accounting and
-- Documentation keep `view` — they do not send CRM email, and this leaves the grant available to
-- hand out rather than assumed.
INSERT INTO "role_permissions" ("role_id", "permission_id", "company_id", "created_at")
SELECT r."id", p."id", r."company_id", NOW()
  FROM "roles" r
  JOIN "permissions" p ON p."permission_name" = 'triggers.edit'
 WHERE r."key" IN ('agent', 'crm')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
