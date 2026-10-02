-- The candidate's agent account becomes a real reference, not just an id that looks like one.
--
-- WHY THIS ONE IS A FOREIGN KEY WHEN THE OTHERS ARE NOT. Every other user id on these tables --
-- assigned_recruiter_id, interviewer_id, actor_id, referred_by_user_id -- records WHAT HAPPENED:
-- who interviewed this person, who advised, who acted. Those are historical facts, and a cascade
-- would quietly erase them while a restriction would make offboarding fail on a year-old interview.
-- They stay plain integers, as `lead_tasks.assigned_to` already does.
--
-- `agent_user_id` is not history. It is a LIVE POINTER that code follows to the account, and an id
-- that no longer resolves is a bug waiting to be found by whoever opens the record. So it gets the
-- reference, and RESTRICT rather than CASCADE or SET NULL:
--
--   CASCADE   would delete the recruitment record when the account went, destroying the account's
--             own provenance -- the thing this module exists to keep.
--   SET NULL  would leave the record claiming nobody was ever hired from it.
--   RESTRICT  refuses to delete a user while a candidate record points at them, which is the
--             honest answer: deal with the recruitment record first, deliberately.
--
-- The UNIQUE index from the previous migration already prevents two candidates sharing one account;
-- this adds the other half, that the account exists at all.
--
-- SAFE ON EXISTING DATA. Every current row has agent_user_id NULL -- nothing has been approved yet
-- -- and NULL is exempt from a foreign key, so the constraint validates against nothing.

ALTER TABLE "recruitment_candidates"
  ADD CONSTRAINT "recruitment_candidates_agent_user_id_fkey"
  FOREIGN KEY ("agent_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
