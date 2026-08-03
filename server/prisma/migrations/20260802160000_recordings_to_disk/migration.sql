-- Call recordings move out of the database.
--
-- They were `bytea`, up to 8 MB per call. Postgres stores that perfectly well; the cost is
-- everything downstream. `pg_dump` reads every byte, so the nightly backup grows with call volume
-- rather than with business data; a restore has to write them all back before the application can
-- start; replication ships them again; and the working set Postgres would like to keep in memory
-- competes with audio that no query ever filters on. A year of a busy brokerage's calls is tens of
-- gigabytes of backup holding data nothing selects.
--
-- NOTHING IS MIGRATED HERE. `data` becomes nullable and a path column appears beside it; every
-- existing row keeps its bytes and is still served from them. Moving files is a separate,
-- deliberate step — scripts/migrate-recordings.cjs — because a migration that silently fails to
-- copy a file would lose the recording of a client conversation, and a schema migration is the
-- wrong place to find that out.
--
-- DEPLOYMENT REQUIREMENT: RECORDING_STORAGE_DIR must be on persistent storage. In a container with
-- no mounted volume it is the container's own filesystem and recordings vanish on restart. The
-- service probes the directory at boot by writing to it, logs loudly if it cannot, and falls back
-- to storing new recordings in the database — slower and older, but never silently lost.

-- Nullable, because new rows keep their bytes on disk instead. Existing rows are untouched.
ALTER TABLE "lead_call_recordings" ALTER COLUMN "data" DROP NOT NULL;

-- Relative, POSIX-style path under the storage root — '2026/08/<random>.m4a'. Relative so the root
-- can differ between environments without rewriting a single row.
ALTER TABLE "lead_call_recordings" ADD COLUMN IF NOT EXISTS "storage_path" VARCHAR(512);

-- Exactly one of the two must be set. Without this a bug could produce a row with neither — a
-- recording that exists in the list, is playable by nobody, and gives no clue where it went — or
-- with both, where nothing says which copy is authoritative.
ALTER TABLE "lead_call_recordings" DROP CONSTRAINT IF EXISTS "lead_call_recordings_one_location";
ALTER TABLE "lead_call_recordings" ADD CONSTRAINT "lead_call_recordings_one_location"
  CHECK (("data" IS NOT NULL AND "storage_path" IS NULL)
      OR ("data" IS NULL AND "storage_path" IS NOT NULL));

-- Finding what is left to migrate, without scanning the audio itself.
CREATE INDEX IF NOT EXISTS "lead_call_recordings_storage_path_idx"
  ON "lead_call_recordings" ("storage_path");
