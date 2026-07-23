-- Audio recording attached to a logged lead call, at most one per call.
--
-- Purely additive: one new table. Nothing existing is altered, and the transaction / document /
-- invoice / commission core is untouched.
--
-- Kept out of `lead_calls` on purpose: the lead detail loads every call for a lead, and the audio
-- must not ride along with that query. The blob is only ever read by the download endpoint.

CREATE TABLE IF NOT EXISTS "lead_call_recordings" (
  "id"           SERIAL PRIMARY KEY,
  "call_id"      INTEGER      NOT NULL UNIQUE,
  "filename"     VARCHAR(255) NOT NULL,
  "content_type" VARCHAR(128) NOT NULL,
  "size"         INTEGER      NOT NULL,
  "data"         BYTEA        NOT NULL,
  "created_by"   VARCHAR(255),
  "created_at"   TIMESTAMP(0),
  CONSTRAINT "lead_call_recordings_call_id_fkey" FOREIGN KEY ("call_id")
    REFERENCES "lead_calls"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
