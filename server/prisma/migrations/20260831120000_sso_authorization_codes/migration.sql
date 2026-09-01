-- One-time codes used to hand an existing CRM identity to an approved external application.
-- The raw code is never persisted: only its SHA-256 digest is stored.
CREATE TABLE "sso_authorization_codes" (
  "id" SERIAL NOT NULL,
  "code_hash" VARCHAR(64) NOT NULL,
  "user_id" INTEGER NOT NULL,
  "client_id" VARCHAR(64) NOT NULL,
  "redirect_uri" VARCHAR(2048) NOT NULL,
  "code_challenge" VARCHAR(128) NOT NULL,
  "expires_at" TIMESTAMP(0) NOT NULL,
  "consumed_at" TIMESTAMP(0),
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sso_authorization_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sso_authorization_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "sso_authorization_codes_code_hash_key"
  ON "sso_authorization_codes"("code_hash");
CREATE INDEX "sso_authorization_codes_user_id_idx"
  ON "sso_authorization_codes"("user_id");
CREATE INDEX "sso_authorization_codes_expires_at_idx"
  ON "sso_authorization_codes"("expires_at");
