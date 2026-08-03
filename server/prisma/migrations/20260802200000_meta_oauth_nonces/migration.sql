-- Redeemed OAuth state nonces, so a captured callback URL cannot be replayed.
--
-- Replaces an in-memory Set that called .clear() once it passed 5,000 entries — after which every
-- previously-redeemed nonce became replayable again inside its ten-minute TTL. It was also empty
-- after a restart and not shared between instances.
--
-- The unique index is the mechanism, not decoration: redeeming is an INSERT that either wins or
-- raises a unique violation, so two callbacks arriving at once cannot both succeed.
CREATE TABLE IF NOT EXISTS "meta_oauth_nonces" (
  "id"         SERIAL       PRIMARY KEY,
  "nonce"      VARCHAR(64)  NOT NULL,
  "expires_at" TIMESTAMP(0) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "meta_oauth_nonces_nonce_key" ON "meta_oauth_nonces" ("nonce");
-- Supports the sweep of expired rows on each redeem.
CREATE INDEX IF NOT EXISTS "meta_oauth_nonces_expires_at_idx" ON "meta_oauth_nonces" ("expires_at");
