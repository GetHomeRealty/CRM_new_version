-- What a candidate brings: experience, licence, availability, and what they would need taught.
--
-- EVERY COLUMN NULLABLE, AND NULL MEANS "NOT ASKED YET" rather than "no". That distinction is the
-- reason the two booleans are nullable instead of defaulting false: during early screening nobody
-- has asked whether somebody is licensed, and recording that as "not licensed" would be a statement
-- the brokerage never made — one a recruiter could later act on as though it had been checked.
--
-- `brokerage_name` SERVES CURRENT AND PREVIOUS, deliberately one column. Which it is follows from
-- `is_licensed`: somebody licensed now is with that brokerage, somebody not is coming from it. Two
-- columns would need a rule for the case where both are filled, and there is no useful answer.
--
-- CHECK CONSTRAINTS RATHER THAN SERVICE VALIDATION ALONE. The service validates too, so the person
-- gets a sentence rather than a constraint error — but `years_experience` of -3 is wrong however it
-- arrives, including by an import or a hand-written UPDATE, and the database is the only layer that
-- sees all of those. `NOT VALID` is not used: the table is new and empty, so there is nothing to
-- grandfather in.
--
-- ADDITIVE ONLY. No existing column is altered, nothing is backfilled, and every current row stays
-- exactly as it is with the new columns NULL.

ALTER TABLE "recruitment_candidates"
  ADD COLUMN "has_real_estate_experience" BOOLEAN,
  ADD COLUMN "years_experience"           SMALLINT,
  ADD COLUMN "is_licensed"                BOOLEAN,
  ADD COLUMN "licence_number"             VARCHAR(64),
  ADD COLUMN "brokerage_name"             VARCHAR(255),
  ADD COLUMN "availability"               VARCHAR(16),
  ADD COLUMN "training_needs"             TEXT;

-- Years cannot be negative. NULL passes, which is the point: unknown is not zero.
ALTER TABLE "recruitment_candidates"
  ADD CONSTRAINT "recruitment_candidates_years_experience_chk"
  CHECK ("years_experience" IS NULL OR "years_experience" >= 0);

-- The three the brokerage uses. Spelled here as well as in the service so a value that never went
-- through the service cannot sit in the column and quietly fail to match any filter.
ALTER TABLE "recruitment_candidates"
  ADD CONSTRAINT "recruitment_candidates_availability_chk"
  CHECK ("availability" IS NULL OR "availability" IN ('full_time', 'part_time', 'flexible'));
