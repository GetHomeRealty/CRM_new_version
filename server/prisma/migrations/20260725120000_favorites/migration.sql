-- Per-user MLS favorites: a listing key + a JSON snapshot of the listing. Additive.

CREATE TABLE IF NOT EXISTS "favorites" (
  "id"          SERIAL PRIMARY KEY,
  "user_id"     INTEGER      NOT NULL,
  "listing_key" VARCHAR(128) NOT NULL,
  "snapshot"    JSONB,
  "notes"       TEXT,
  "created_at"  TIMESTAMP(0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "favorites_user_id_listing_key_key" ON "favorites"("user_id", "listing_key");
CREATE INDEX IF NOT EXISTS "favorites_user_id_idx" ON "favorites"("user_id");
