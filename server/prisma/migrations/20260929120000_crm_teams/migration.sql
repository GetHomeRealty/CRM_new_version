-- CRM Teams: team-level lead ownership.
--
-- A lead can now be owned by a TEAM (`leads.team_id`) as well as by an agent (private) or by the
-- brokerage. The handling agent stays in `leads.assigned_to`, which was already nullable and already
-- separate from ownership, so it is NOT duplicated as a second column: the API exposes it as
-- `assigned_to_user_id` for the team screens.
--
-- ADDITIVE AND INERT ON DAY ONE. Every existing lead gets `team_id = NULL`, so its ownership, its
-- visibility and every count built on it are exactly what they were until someone creates a team.
--
-- IDEMPOTENT (IF NOT EXISTS / guarded DO blocks) so it can be applied by hand to a local database
-- whose history has forked and still be safe when `migrate deploy` later runs it for real.

-- ---------------------------------------------------------------------------------------- teams
CREATE TABLE IF NOT EXISTS "crm_teams" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "team_lead_user_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    CONSTRAINT "crm_teams_pkey" PRIMARY KEY ("id")
);

-- Two teams called "Pre-Con East" and "pre-con east" would be indistinguishable in every dropdown.
CREATE UNIQUE INDEX IF NOT EXISTS "crm_teams_name_lower_key" ON "crm_teams" (LOWER("name"));
CREATE INDEX IF NOT EXISTS "crm_teams_team_lead_user_id_idx" ON "crm_teams"("team_lead_user_id");

DO $$ BEGIN
  ALTER TABLE "crm_teams" ADD CONSTRAINT "crm_teams_team_lead_user_id_fkey"
    FOREIGN KEY ("team_lead_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -------------------------------------------------------------------------------------- members
CREATE TABLE IF NOT EXISTS "crm_team_members" (
    "id" SERIAL NOT NULL,
    "team_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(0),
    CONSTRAINT "crm_team_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "crm_team_members_team_id_user_id_key" ON "crm_team_members"("team_id", "user_id");
CREATE INDEX IF NOT EXISTS "crm_team_members_user_id_idx" ON "crm_team_members"("user_id");

DO $$ BEGIN
  ALTER TABLE "crm_team_members" ADD CONSTRAINT "crm_team_members_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "crm_teams"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "crm_team_members" ADD CONSTRAINT "crm_team_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------------------- leads
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "team_id" INTEGER;

-- DERIVED, NEVER WRITTEN. Stored so reports can group and filter on it, generated so that no
-- intake path (manual, CSV import, Meta sync) has to remember to set it and none can get it wrong.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "ownership_type" VARCHAR(16)
  GENERATED ALWAYS AS (
    CASE
      WHEN "owner_user_id" IS NOT NULL THEN 'PRIVATE'
      WHEN "team_id" IS NOT NULL THEN 'TEAM'
      ELSE 'BROKERAGE'
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS "leads_team_id_idx" ON "leads"("team_id");

-- A team does not get deleted out from under the leads it owns: deactivate it instead.
DO $$ BEGIN
  ALTER TABLE "leads" ADD CONSTRAINT "leads_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "crm_teams"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An agent's private lead is never also a team's. Private-lead rules stay exactly as they were.
DO $$ BEGIN
  ALTER TABLE "leads" ADD CONSTRAINT "leads_private_or_team_chk"
    CHECK ("owner_user_id" IS NULL OR "team_id" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------------- assignment history
CREATE TABLE IF NOT EXISTS "crm_lead_assignment_events" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "from_team_id" INTEGER,
    "from_team_name" VARCHAR(120),
    "to_team_id" INTEGER,
    "to_team_name" VARCHAR(120),
    "from_user_id" INTEGER,
    "from_user_name" VARCHAR(255),
    "to_user_id" INTEGER,
    "to_user_name" VARCHAR(255),
    "actor_user_id" INTEGER,
    "actor_name" VARCHAR(255),
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_lead_assignment_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "crm_lead_assignment_events_lead_id_created_at_idx"
  ON "crm_lead_assignment_events"("lead_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "crm_lead_assignment_events" ADD CONSTRAINT "crm_lead_assignment_events_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
