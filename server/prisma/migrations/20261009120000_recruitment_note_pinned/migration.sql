-- Pinning a recruitment note, so the ones that matter stay at the top of a long history.
--
-- ADDITIVE, NOT NULL WITH A DEFAULT, so every existing note becomes unpinned without a backfill
-- pass and without a window where the column reads NULL. Nothing that currently writes a note
-- mentions this column, so every existing insert keeps working unchanged.
--
-- NOT A "ONE PINNED NOTE PER CANDIDATE" CONSTRAINT. Several notes may be pinned at once, which is
-- the point: a candidate's licence number, their availability and what the last interviewer thought
-- are three separate things somebody wants at the top, not one slot they take turns in.
--
-- NO INDEX ON IT. The only read that sorts by `pinned` is one candidate's own notes, already
-- narrowed by `recruitment_notes_candidate_id_idx` to the tens of rows a candidate accumulates.
-- Sorting those in memory costs nothing, and a partial index cannot be expressed in
-- `schema.prisma` — adding one here would show up forever as drift against the schema.
ALTER TABLE "recruitment_notes"
  ADD COLUMN IF NOT EXISTS "pinned" BOOLEAN NOT NULL DEFAULT false;
