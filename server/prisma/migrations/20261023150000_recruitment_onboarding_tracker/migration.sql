-- RECRUITMENT → ONBOARDING & TRAINING: the brokerage's "Onboarding & Trainings" sheet, as a tab.
--
-- Three tables, the sheet's own shape:
--   recruitment_onboarding_steps   the columns — 17 onboarding steps and 12 training topics, seeded
--                                  below with the sheet's wording. Administrators may add, rename,
--                                  reorder and hide them; a hidden step keeps its marks.
--   recruitment_onboarding_people  the rows — one per agent being onboarded. Most of the sheet's agents
--                                  joined before Recruitment existed, so a person is NOT a candidate:
--                                  `candidate_id` links one when there is one (unique, SET NULL so a
--                                  deleted candidate leaves the agent's onboarding history standing).
--   recruitment_onboarding_marks   the cells — one value per person and step. No row means blank.
--
-- `tag` keeps the sheet's "(FE)" / "(FF)" suffix that is written after many names, so the import does
-- not lose it; the name is stored without it.
--
-- ROOT, not hung off `users` or `recruitment_candidates`: see data-ownership.spec.ts.

CREATE TABLE IF NOT EXISTS "recruitment_onboarding_steps" (
  "id"          SERIAL        PRIMARY KEY,
  "kind"        VARCHAR(16)   NOT NULL,
  "title"       VARCHAR(255)  NOT NULL,
  "position"    INTEGER       NOT NULL DEFAULT 0,
  "hidden_at"   TIMESTAMP(0),
  "created_by"  VARCHAR(255),
  "created_at"  TIMESTAMP(0),
  "updated_at"  TIMESTAMP(0),

  CONSTRAINT "recruitment_onboarding_steps_kind_chk" CHECK ("kind" IN ('onboarding', 'training'))
);
CREATE INDEX IF NOT EXISTS "recruitment_onboarding_steps_kind_position_idx" ON "recruitment_onboarding_steps"("kind", "position");

CREATE TABLE IF NOT EXISTS "recruitment_onboarding_people" (
  "id"            SERIAL        PRIMARY KEY,
  "name"          VARCHAR(255)  NOT NULL,
  "tag"           VARCHAR(16),
  "candidate_id"  INTEGER,
  "added_by"      VARCHAR(255),
  "created_at"    TIMESTAMP(0),
  "updated_at"    TIMESTAMP(0),
  "removed_at"    TIMESTAMP(0),

  CONSTRAINT "recruitment_onboarding_people_candidate_id_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id")
    ON DELETE SET NULL ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "recruitment_onboarding_people_candidate_id_key" ON "recruitment_onboarding_people"("candidate_id");
CREATE INDEX IF NOT EXISTS "recruitment_onboarding_people_removed_at_idx" ON "recruitment_onboarding_people"("removed_at");

CREATE TABLE IF NOT EXISTS "recruitment_onboarding_marks" (
  "id"          SERIAL        PRIMARY KEY,
  "person_id"   INTEGER       NOT NULL,
  "step_id"     INTEGER       NOT NULL,
  "value"       VARCHAR(24)   NOT NULL,
  "updated_by"  VARCHAR(255),
  "updated_at"  TIMESTAMP(0),

  CONSTRAINT "recruitment_onboarding_marks_person_id_fkey"
    FOREIGN KEY ("person_id") REFERENCES "recruitment_onboarding_people"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "recruitment_onboarding_marks_step_id_fkey"
    FOREIGN KEY ("step_id") REFERENCES "recruitment_onboarding_steps"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  -- The sheet's drop-down values. Mirrored by ONBOARDING_VALUES in recruitment-onboarding.service.ts.
  CONSTRAINT "recruitment_onboarding_marks_value_chk"
    CHECK ("value" IN ('yes', 'no', 'in_progress', 'not_attended', 'na', 'own_email', 'interested'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "recruitment_onboarding_marks_person_id_step_id_key" ON "recruitment_onboarding_marks"("person_id", "step_id");
CREATE INDEX IF NOT EXISTS "recruitment_onboarding_marks_step_id_idx" ON "recruitment_onboarding_marks"("step_id");

-- The sheet's columns, in the sheet's order and wording. Only into an empty table, so re-running this
-- never duplicates them or undoes an administrator's renames.
INSERT INTO "recruitment_onboarding_steps" ("kind", "title", "position", "created_by", "created_at", "updated_at")
SELECT v.kind, v.title, v.position, 'Onboarding & Trainings sheet', NOW(), NOW()
FROM (VALUES
  ('onboarding', 'INTERVIEW MEETING SCHEDULE', 1),
  ('onboarding', 'ONBOARDING EMAIL', 2),
  ('onboarding', 'CREATING WHATSAPP SUPPORT GRP', 3),
  ('onboarding', 'Follow-Up on RECO Registration Process', 4),
  ('onboarding', 'Follow-Up on TREB Registration Process', 5),
  ('onboarding', 'HEADSHOT (Canada Office)', 6),
  ('onboarding', 'TEMPLATE IN ZOHO', 7),
  ('onboarding', 'EMAIL SIGNATURE', 8),
  ('onboarding', 'CREATE OFFICIAL GHR EMAIL', 9),
  ('onboarding', 'NEW AGENT TO COMPANY WEBSITE', 10),
  ('onboarding', 'WELCOME POSTER', 11),
  ('onboarding', 'BUSINESS CARDS', 12),
  ('onboarding', 'SALE/LEASE BOARDS', 13),
  ('onboarding', 'AGENT INTRO VIDEO', 14),
  ('onboarding', 'TRAININGS', 15),
  ('onboarding', 'WELCOME KIT (BAG / MUG / FILE / PEN)', 16),
  ('onboarding', 'Highlight New Agent on Internal Agent''s Closed Deals in Advertising', 17),
  ('training', 'EXPLORING MLS', 1),
  ('training', 'ULTIMATE SHOWINGS', 2),
  ('training', 'DOCUMENTATION', 3),
  ('training', 'NEGOTIATION SKILLS', 4),
  ('training', 'LISTING PRESENTATION', 5),
  ('training', 'END-TO-END SUPPORT TO CLIENTS & MARKETING & ADVERTISING', 6),
  ('training', 'Tools & SOFT SPOKEN SKILLS (Sai garu)', 7),
  ('training', 'Commercial', 8),
  ('training', 'ROLE PLAY', 9),
  ('training', 'Pre-Constructions', 10),
  ('training', 'Leases', 11),
  ('training', 'Case Study', 12)
) AS v(kind, title, position)
WHERE NOT EXISTS (SELECT 1 FROM "recruitment_onboarding_steps");

-- LET THE APPLICATION USE THEM. Migrations run as the owner while the app connects as its own user
-- (see 20261019130000_payment_sheet_rows_access). Granted to exactly whoever can already use
-- recruitment_candidates, so nobody gains access to recruitment they did not already have.
DO $$
DECLARE r record; t text;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee AS role FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'recruitment_candidates' AND privilege_type = 'SELECT'
       AND grantee NOT IN ('postgres', 'PUBLIC')
    UNION
    SELECT tableowner FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'recruitment_candidates' AND tableowner <> 'postgres'
  LOOP
    FOREACH t IN ARRAY ARRAY['recruitment_onboarding_steps', 'recruitment_onboarding_people', 'recruitment_onboarding_marks'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I', t, r.role);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', t || '_id_seq', r.role);
    END LOOP;
  END LOOP;
END $$;
