-- Team Lead: an Agent who manages a team of Agents from the Users module.
--
-- WHY A FLAG AND NOT A NEW ROLE. A Team Lead keeps `role = 'agent'`. Every other module decides
-- "this person sees only their own records" by testing for that role (`isAgent`, and a dozen inline
-- `role === 'agent'` checks in Reports, Quick Actions and Exports). A new role key would fail every
-- one of those tests and be treated as brokerage staff: every deal, every lead, every document. The
-- requirement is that no module other than Users and Dashboard changes, so the Team Lead is an Agent
-- everywhere else, and only Users and Dashboard read `is_team_lead`.
--
-- ADDITIVE AND INERT ON DAY ONE. Every existing row gets `is_team_lead = false` and NULL for both
-- pointers, so nobody's access, visibility or counts change until a Super Admin makes a Team Lead.
--
-- SET NULL on both pointers, deliberately:
--   team_lead_id   an Agent whose Team Lead account is deleted is simply unassigned, the same state
--                  as "no replacement Team Lead yet". The Agent account and its history stay.
--   created_by_id  provenance only; deleting the creator must not be blocked by, or delete, the
--                  accounts they created.
--
-- IDEMPOTENT (IF NOT EXISTS / guarded DO blocks), like the other recent migrations, so it can be
-- applied by hand to a local database and still be safe when `migrate deploy` runs it.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_team_lead" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "team_lead_id" INTEGER;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_by_id" INTEGER;

CREATE INDEX IF NOT EXISTS "users_team_lead_id_idx" ON "users"("team_lead_id");

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_team_lead_id_fkey"
    FOREIGN KEY ("team_lead_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
