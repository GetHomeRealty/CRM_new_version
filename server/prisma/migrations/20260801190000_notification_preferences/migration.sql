-- Per-user push notification preferences.
--
-- No backfill and no defaults are inserted. A missing row means "enabled", so every existing user
-- keeps receiving exactly what they receive today; only an explicit opt-out writes a row.

CREATE TABLE "notification_preferences" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3),
    "company_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_preferences_user_id_category_key"
    ON "notification_preferences"("user_id", "category");

CREATE INDEX "notification_preferences_user_id_idx"
    ON "notification_preferences"("user_id");

CREATE INDEX "notification_preferences_company_id_idx"
    ON "notification_preferences"("company_id");

ALTER TABLE "notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
