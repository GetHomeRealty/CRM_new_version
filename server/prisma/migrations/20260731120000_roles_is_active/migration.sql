-- A role can be retired without being deleted.
--
-- Deleting a role that people hold would leave those accounts with a role string pointing at
-- nothing, which under fail-closed authorization means they can open nothing — a deletion in the
-- roles screen would silently lock users out. Deactivating is the safe form of the same intent:
-- the role stops being offered for new assignments and stops granting anything, but the rows that
-- reference it stay readable and the decision is reversible.
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
