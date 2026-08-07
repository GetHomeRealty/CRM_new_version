-- Two-factor authentication.
--
-- Four per-user tables and one per-brokerage policy table. Additive only: nothing existing is
-- altered, so this is safe to apply to a live database while it is serving.
--
-- HAND-WRITTEN, DELIBERATELY. `prisma migrate diff` against the schema also emits a long tail of
-- unrelated drift — dropping `campaigns_scheduled_for_idx` and `transactions_agent_user_id_idx`,
-- renaming a dozen indexes, and re-creating foreign keys on calendar, crm_settings and
-- push_subscriptions — because earlier migrations were hand-written and the recorded history no
-- longer matches what Prisma would generate from the schema. None of that belongs in a two-factor
-- migration, and dropping working indexes as a side effect of adding a feature would be a genuine
-- regression. Only the MFA objects are below.

-- One row per enrolled factor.
CREATE TABLE "user_mfa_methods" (
    "id"           SERIAL       NOT NULL,
    "user_id"      INTEGER      NOT NULL,
    "type"         VARCHAR(16)  NOT NULL,
    "secret"       TEXT,
    "destination"  VARCHAR(255),
    "confirmed_at" TIMESTAMP(0),
    "last_step"    BIGINT,
    "last_used_at" TIMESTAMP(0),
    "created_at"   TIMESTAMP(0) NOT NULL,
    "updated_at"   TIMESTAMP(0) NOT NULL,
    "company_id"   INTEGER      NOT NULL DEFAULT 1,

    CONSTRAINT "user_mfa_methods_pkey" PRIMARY KEY ("id")
);

-- Single-use codes for a lost second factor. Stored hashed.
CREATE TABLE "mfa_recovery_codes" (
    "id"         SERIAL       NOT NULL,
    "user_id"    INTEGER      NOT NULL,
    "code_hash"  VARCHAR(64)  NOT NULL,
    "used_at"    TIMESTAMP(0),
    "used_ip"    VARCHAR(64),
    "created_at" TIMESTAMP(0) NOT NULL,
    "company_id" INTEGER      NOT NULL DEFAULT 1,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- "Do not ask again on this device."
CREATE TABLE "mfa_trusted_devices" (
    "id"           SERIAL       NOT NULL,
    "user_id"      INTEGER      NOT NULL,
    "token_hash"   VARCHAR(64)  NOT NULL,
    "label"        VARCHAR(120),
    "user_agent"   VARCHAR(255),
    "ip"           VARCHAR(64),
    "last_seen_at" TIMESTAMP(0),
    "expires_at"   TIMESTAMP(0) NOT NULL,
    "revoked_at"   TIMESTAMP(0),
    "created_at"   TIMESTAMP(0) NOT NULL,
    "company_id"   INTEGER      NOT NULL DEFAULT 1,

    CONSTRAINT "mfa_trusted_devices_pkey" PRIMARY KEY ("id")
);

-- Outstanding email/SMS codes. Short-lived.
CREATE TABLE "mfa_challenges" (
    "id"          SERIAL       NOT NULL,
    "user_id"     INTEGER      NOT NULL,
    "method"      VARCHAR(16)  NOT NULL,
    "code_hash"   VARCHAR(64)  NOT NULL,
    "attempts"    INTEGER      NOT NULL DEFAULT 0,
    "expires_at"  TIMESTAMP(0) NOT NULL,
    "consumed_at" TIMESTAMP(0),
    "created_at"  TIMESTAMP(0) NOT NULL,
    "company_id"  INTEGER      NOT NULL DEFAULT 1,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- Whether a role must hold a second factor, per brokerage.
CREATE TABLE "mfa_policies" (
    "id"         SERIAL       NOT NULL,
    "role"       VARCHAR(64)  NOT NULL,
    "required"   BOOLEAN      NOT NULL DEFAULT false,
    "grace_days" INTEGER      NOT NULL DEFAULT 7,
    "created_at" TIMESTAMP(0) NOT NULL,
    "updated_at" TIMESTAMP(0) NOT NULL,
    "company_id" INTEGER      NOT NULL DEFAULT 1,

    CONSTRAINT "mfa_policies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX        "user_mfa_methods_user_id_idx"       ON "user_mfa_methods"("user_id");
CREATE UNIQUE INDEX "user_mfa_methods_user_id_type_key"  ON "user_mfa_methods"("user_id", "type");

CREATE INDEX        "mfa_recovery_codes_user_id_idx"     ON "mfa_recovery_codes"("user_id");
CREATE INDEX        "mfa_recovery_codes_code_hash_idx"   ON "mfa_recovery_codes"("code_hash");

CREATE UNIQUE INDEX "mfa_trusted_devices_token_hash_key" ON "mfa_trusted_devices"("token_hash");
CREATE INDEX        "mfa_trusted_devices_user_id_idx"    ON "mfa_trusted_devices"("user_id");
CREATE INDEX        "mfa_trusted_devices_expires_at_idx" ON "mfa_trusted_devices"("expires_at");

CREATE INDEX        "mfa_challenges_user_id_idx"         ON "mfa_challenges"("user_id");
CREATE INDEX        "mfa_challenges_expires_at_idx"      ON "mfa_challenges"("expires_at");

CREATE INDEX        "mfa_policies_company_id_idx"        ON "mfa_policies"("company_id");
CREATE UNIQUE INDEX "mfa_policies_company_id_role_key"   ON "mfa_policies"("company_id", "role");

-- ON DELETE CASCADE throughout: when an account is deleted its factors, recovery codes, trusted
-- devices and outstanding challenges must go with it. An orphaned trusted-device row would leave a
-- working credential behind for an account that no longer exists.
ALTER TABLE "user_mfa_methods"
    ADD CONSTRAINT "user_mfa_methods_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "mfa_recovery_codes"
    ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "mfa_trusted_devices"
    ADD CONSTRAINT "mfa_trusted_devices_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "mfa_challenges"
    ADD CONSTRAINT "mfa_challenges_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "mfa_policies"
    ADD CONSTRAINT "mfa_policies_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
