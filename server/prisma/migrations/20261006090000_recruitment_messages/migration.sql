-- Texts sent to a candidate from Recruitment, and what became of each one.
--
-- WHY A TABLE AND NOT A `recruitment_events` ROW. History is append-only: an event records that
-- something happened and is never revised. A sent text is not finished when it leaves — it moves
-- queued -> sent -> delivered, or -> failed, over seconds or minutes, reported by Twilio long after
-- the request that sent it has returned. That is a row with a changing status, which is a record,
-- not an event. Both are written: this row carries the status, and a `recruitment_events` row
-- records the send for the history the recruiter reads.
--
-- IT MIRRORS `lead_messages` DELIBERATELY, down to the column names and the `provider_sid` unique
-- index. The same Twilio status callback has to find a row in either table, and a callback that had
-- to remember two different shapes is how one of them ends up never being updated.
--
-- `provider_sid` IS UNIQUE because that is what the callback looks a row up by. Without the
-- constraint two rows could claim the same SID and the update would pick one arbitrarily.
--
-- NO `read` STATUS IS EVER SET HERE. Plain SMS has no read receipt; `lead_messages` allows one only
-- because an agent can mark it by hand from what the lead told them. Recruitment has no such
-- control, so the status only ever holds what Twilio reported.
--
-- ON DELETE CASCADE from the candidate, matching every other recruitment child table: removing a
-- candidate removes what was sent to them.

CREATE TABLE "recruitment_messages" (
  "id"            SERIAL       PRIMARY KEY,
  "candidate_id"  INTEGER      NOT NULL,
  -- queued | sent | delivered | failed. Set from Twilio's reply, then from its status callback.
  "status"        VARCHAR(16)  NOT NULL DEFAULT 'queued',
  -- Twilio's Message SID, so a status callback can find this row. Null when the send never reached
  -- Twilio at all, which is exactly when there is no SID to record.
  "provider_sid"  VARCHAR(64),
  "error_code"    VARCHAR(16),
  "error_message" VARCHAR(255),
  "body"          TEXT         NOT NULL,
  -- The number as it was dialled, in E.164. Kept on the row because the candidate's number may be
  -- corrected later, and this must still say where the text actually went.
  "phone"         VARCHAR(64)  NOT NULL,
  "sent_at"       TIMESTAMP(0) NOT NULL,
  "created_by"    VARCHAR(255),
  "user_id"       INTEGER,
  "created_at"    TIMESTAMP(0),
  "updated_at"    TIMESTAMP(0),

  CONSTRAINT "recruitment_messages_candidate_id_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,

  CONSTRAINT "recruitment_messages_status_chk"
    CHECK ("status" IN ('queued', 'sent', 'delivered', 'failed'))
);

CREATE UNIQUE INDEX "recruitment_messages_provider_sid_key"
  ON "recruitment_messages" ("provider_sid");

CREATE INDEX "recruitment_messages_candidate_id_idx" ON "recruitment_messages" ("candidate_id");
CREATE INDEX "recruitment_messages_status_idx"       ON "recruitment_messages" ("status");
CREATE INDEX "recruitment_messages_sent_at_idx"      ON "recruitment_messages" ("sent_at");
