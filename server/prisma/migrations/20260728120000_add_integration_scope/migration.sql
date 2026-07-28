-- Separate CRM and Transaction Desk integrations.
--
-- CRM Settings and Transaction Desk Settings each manage their own email and calendar
-- connections: an address added on one side must never appear on the other.
--
-- Additive and non-destructive: no table is renamed or dropped, no row is deleted, and no
-- stored credential is touched.

-- mail_accounts.scope — 'crm' | 'desk'. NULL means "not yet assigned": accounts that
-- pre-date the split keep showing on both sides until they are assigned from Settings, so
-- nothing disappeared when this column arrived.
ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "scope" VARCHAR(8);

-- google_connections.scope — the two areas hold independent OAuth grants. Existing
-- connections become 'crm', because the Google Calendar card originally lived in
-- CRM Settings -> Integrations.
ALTER TABLE "google_connections" ADD COLUMN IF NOT EXISTS "scope" VARCHAR(8) NOT NULL DEFAULT 'crm';

-- A user may now hold one connection per area, so the pair is what must be unique.
ALTER TABLE "google_connections" DROP CONSTRAINT IF EXISTS "google_connections_user_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "google_connections_user_id_scope_key"
  ON "google_connections" ("user_id", "scope");
