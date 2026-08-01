-- A version counter on calendar events and to-dos, so a save can tell it is overwriting.
--
-- Two people editing the same appointment both got 200 and the later write silently won: the
-- earlier person's change was gone with nothing said to either of them. `updated_at` cannot serve
-- as the token here -- it is Timestamp(0), so two saves inside the same second carry the identical
-- value and the conflict would go unseen. An integer bumped on every write has no such gap.
--
-- DEFAULT 1 rather than 0 so existing rows read as "version 1" instead of looking unsaved, and
-- NOT NULL so there is never a row whose version has to be guessed at.
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "todos"           ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
