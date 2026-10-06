-- Whether a candidate has agreed to be texted, recorded rather than assumed.
--
-- ================================================================================================
-- NULLABLE WITH NO DEFAULT, AND NO BACKFILL. THIS IS THE WHOLE POINT OF THE MIGRATION.
--
-- `DEFAULT false` would be wrong in a quiet way and `DEFAULT true` wrong in a loud one, but the
-- real error would be either: both invent an answer on behalf of every candidate already on file,
-- nobody asked them, and the column would then claim a conversation that never happened.
--
-- So there are three states and they stay three:
--
--   NULL   nobody has recorded an answer         -> cannot be texted
--   false  they said no, or withdrew             -> cannot be texted
--   true   they agreed, and who recorded it      -> may be texted
--
-- Every existing candidate is NULL, so nothing can be texted until somebody records the agreement.
-- That is deliberate friction: the alternative is a migration that silently grants consent for
-- several hundred people, which is exactly the thing consent rules exist to prevent.
--
-- THIS SITS ON TOP OF THE CARRIER'S LIST, IT DOES NOT REPLACE IT. Twilio's Messaging Service still
-- holds the STOP list and still refuses anyone on it with error 21610. That is the recipient's own
-- instruction to the carrier and no column here can override it. This records the brokerage's end
-- of the same agreement, which the carrier cannot know about.
--
-- WHO AND WHEN ARE STORED BESIDE IT. A bare boolean is not a record of consent — "yes" with nobody's
-- name and no date cannot be relied on afterwards, by the brokerage or by anybody asking it to
-- account for itself.
-- ================================================================================================

ALTER TABLE "recruitment_candidates"
  ADD COLUMN "sms_consent"      BOOLEAN,
  ADD COLUMN "sms_consent_at"   TIMESTAMP(0),
  ADD COLUMN "sms_consent_by"   VARCHAR(255),
  -- How it was obtained, in the recorder's words: "said yes on the phone", "ticked the form".
  ADD COLUMN "sms_consent_note" VARCHAR(255);

-- An answer must carry its provenance. A row claiming consent with no date and no recorder is a
-- claim nobody can stand behind, and the constraint stops one being written by an import or by a
-- future code path that forgets.
ALTER TABLE "recruitment_candidates"
  ADD CONSTRAINT "recruitment_candidates_sms_consent_chk"
  CHECK (
    "sms_consent" IS NULL
    OR ("sms_consent_at" IS NOT NULL AND "sms_consent_by" IS NOT NULL)
  );

-- Finding who may be texted is a filter on a list, so it is worth an index on the answer.
CREATE INDEX "recruitment_candidates_sms_consent_idx"
  ON "recruitment_candidates" ("sms_consent");
