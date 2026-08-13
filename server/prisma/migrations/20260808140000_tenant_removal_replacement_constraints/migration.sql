-- Replacement constraints for the removal of multi-brokerage tenancy. ADDITIVE ONLY.
--
-- Nothing is dropped here. Every constraint below is created ALONGSIDE the tenant-scoped one it
-- will replace, so this migration can be applied, verified and left in place indefinitely — and
-- rolled back by dropping the new indexes alone. The companion migration that drops `company_id`
-- runs separately, and must not run until this one has.
--
-- WHY THE ORDER MATTERS MORE THAN USUAL HERE. Three of these constraints lead with `company_id`
-- and nothing else:
--
--     crm_settings          UNIQUE (company_id) WHERE user_id IS NULL
--     crm_email_settings    UNIQUE (company_id)
--     subscriptions         UNIQUE (company_id)
--
-- Dropping that column does NOT narrow those constraints, it DELETES them — a unique index over no
-- remaining columns is not an index. Each one is the only thing stopping a second row, and a second
-- row in any of the three is silent: the reads are `findFirst`, so the application would simply
-- start obeying whichever row sorted first. That is a second SMTP configuration governing outbound
-- CRM mail, or a second licence row deciding whether CRM and Transaction Desk are enabled at all.
--
-- WHAT REPLACES THEM. A unique index on the constant expression `(true)`: every row produces the
-- same key, so the index admits exactly one row. Partial where the original was partial, so the
-- personal `crm_settings` rows — already covered by their own unique on `user_id` — stay untouched.
-- Verified against PostgreSQL 17 before this was written: the second insert is refused with a
-- duplicate-key error on `((true))`.
--
-- The other four are ordinary narrowings and are semantically identical once one brokerage remains:
-- the leading column held a single value, so removing it cannot merge two previously-distinct keys.

-- ---------------------------------------------------------------- singletons
-- At most one shared CRM settings row. Partial, exactly as its predecessor was: rows with a
-- `user_id` are personal settings, covered by `crm_settings_user_id_key`, and must not be caught.
CREATE UNIQUE INDEX IF NOT EXISTS "crm_settings_single_global_key"
  ON "crm_settings" ((true)) WHERE "user_id" IS NULL;

-- Exactly one CRM outbound-email configuration.
CREATE UNIQUE INDEX IF NOT EXISTS "crm_email_settings_singleton_key"
  ON "crm_email_settings" ((true));

-- Exactly one licence row. This is what gates CRM against Transaction Desk, so a duplicate here
-- would decide module access for the whole brokerage by row order.
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_singleton_key"
  ON "subscriptions" ((true));

-- ---------------------------------------------------------------- narrowings
-- One address appears at most once in one agent's book.
--
-- COALESCE is carried over unchanged and is still load-bearing: PostgreSQL treats NULLs as distinct
-- in a unique index, so without it every unowned row — which is what unattributed brokerage intake
-- looks like, and the highest-volume source there is — would be exempt from the constraint
-- entirely. 0 is safe as the sentinel because `users.id` is a positive identity column.
--
-- ON A LARGE `leads` TABLE, READ THIS FIRST. Built non-concurrently, which takes an ACCESS EXCLUSIVE
-- lock for the duration. That is instantaneous on a few thousand rows and is NOT acceptable at the
-- 2.5M-row scale this deployment is sized for. For a production run of that size, create it out of
-- band first and let the IF NOT EXISTS below turn into a no-op:
--
--     CREATE UNIQUE INDEX CONCURRENTLY "leads_owner_email_key"
--       ON "leads" (COALESCE("owner_user_id", 0), LOWER("email"));
--     CREATE INDEX CONCURRENTLY "leads_email_lower_idx" ON "leads" (LOWER("email"));
--
-- CONCURRENTLY cannot run inside a transaction block, which is why it is not written that way here.
CREATE UNIQUE INDEX IF NOT EXISTS "leads_owner_email_key"
  ON "leads" (COALESCE("owner_user_id", 0), LOWER("email"));

-- The other question the module asks constantly: "is this address anywhere in the brokerage?"
-- Asked by the import and by the duplicate check on every lead create. The predecessor led with
-- `company_id`, a single-valued column, which made it near-useless for this lookup.
CREATE INDEX IF NOT EXISTS "leads_email_lower_idx"
  ON "leads" (LOWER("email"));

-- One Meta lead form belongs to one agent. Partial on `is_active` for the original reason: a form
-- somebody connected and later turned off must be free for whoever is running it now.
CREATE UNIQUE INDEX IF NOT EXISTS "meta_lead_forms_page_form_v2_key"
  ON "meta_lead_forms" ("page_id", "form_id") WHERE "is_active";

-- Role keys are unique. RBAC identity.
CREATE UNIQUE INDEX IF NOT EXISTS "roles_key_key" ON "roles" ("key");

-- One two-factor policy per role.
CREATE UNIQUE INDEX IF NOT EXISTS "mfa_policies_role_key" ON "mfa_policies" ("role");
