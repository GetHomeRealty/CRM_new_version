-- WHATSAPP SUPPORT ROTATION: incoming WhatsApp enquiries are handed to whichever support-team member
-- is on duty, each member taking a turn of a set length, in order, round and round.
--
--   whatsapp_rotation_settings  one row: on/off, and when member 1's first turn began
--   whatsapp_rotation_members   the rota, in turn order, with each person's turn length
--   whatsapp_intake             every incoming message and who it went to, with the turn it fell in
--
-- Who is on duty is COUNTED, not stored: it is a function of the clock, the start time and the rota,
-- so nothing has to run when a turn ends for the next message to reach the next person.

CREATE TABLE IF NOT EXISTS "whatsapp_rotation_settings" (
  "id"              SERIAL        PRIMARY KEY,
  "is_enabled"      BOOLEAN       NOT NULL DEFAULT true,
  "cycle_starts_at" TIMESTAMP(0)  NOT NULL,
  "updated_by"      VARCHAR(255),
  "updated_at"      TIMESTAMP(0)  NOT NULL
);

CREATE TABLE IF NOT EXISTS "whatsapp_rotation_members" (
  "id"               SERIAL        PRIMARY KEY,
  "user_id"          INTEGER       NOT NULL,
  "position"         INTEGER       NOT NULL,
  "duration_minutes" INTEGER       NOT NULL,
  "is_active"        BOOLEAN       NOT NULL DEFAULT true,
  "created_at"       TIMESTAMP(0)  NOT NULL,
  "updated_at"       TIMESTAMP(0)  NOT NULL,

  CONSTRAINT "whatsapp_rotation_members_duration_chk"
    CHECK ("duration_minutes" BETWEEN 5 AND 10080)
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_rotation_members_user_id_key" ON "whatsapp_rotation_members"("user_id");
CREATE INDEX IF NOT EXISTS "whatsapp_rotation_members_position_idx" ON "whatsapp_rotation_members"("position");

-- ON DELETE CASCADE from the lead: a deleted lead takes its WhatsApp intake rows with it.
CREATE TABLE IF NOT EXISTS "whatsapp_intake" (
  "id"                 SERIAL        PRIMARY KEY,
  "wa_message_id"      VARCHAR(128)  NOT NULL,
  "lead_id"            INTEGER       NOT NULL,
  "from_phone"         VARCHAR(32)   NOT NULL,
  "profile_name"       VARCHAR(255),
  "message_type"       VARCHAR(24)   NOT NULL,
  "body"               TEXT          NOT NULL,
  "is_new_lead"        BOOLEAN       NOT NULL,
  "assigned_user_id"   INTEGER,
  "assigned_user_name" VARCHAR(255),
  "slot_starts_at"     TIMESTAMP(0),
  "slot_ends_at"       TIMESTAMP(0),
  "received_at"        TIMESTAMP(0)  NOT NULL,
  "created_at"         TIMESTAMP(0)  NOT NULL,

  CONSTRAINT "whatsapp_intake_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_intake_wa_message_id_key" ON "whatsapp_intake"("wa_message_id");
CREATE INDEX IF NOT EXISTS "whatsapp_intake_lead_id_idx" ON "whatsapp_intake"("lead_id");
CREATE INDEX IF NOT EXISTS "whatsapp_intake_received_at_idx" ON "whatsapp_intake"("received_at");

-- LET THE APPLICATION USE THEM. Migrations run as the owner while the app connects as its own user,
-- and there are no default privileges, so a new table is unreadable to the app until granted (the
-- lesson of 20261019130000_payment_sheet_rows_access). Granted to exactly whoever can already use
-- leads, plus its owner when that is not postgres. Re-running it changes nothing.
DO $$
DECLARE r record; t text;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee AS role FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'leads' AND privilege_type = 'SELECT'
       AND grantee NOT IN ('postgres', 'PUBLIC')
    UNION
    SELECT tableowner FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'leads' AND tableowner <> 'postgres'
  LOOP
    FOREACH t IN ARRAY ARRAY['whatsapp_rotation_settings', 'whatsapp_rotation_members', 'whatsapp_intake'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I', t, r.role);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', t || '_id_seq', r.role);
    END LOOP;
  END LOOP;
END $$;
