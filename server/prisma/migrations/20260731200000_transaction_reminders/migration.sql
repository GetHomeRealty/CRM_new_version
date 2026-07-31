-- Reminder history and in-app reminder notifications, plus the index the listing-expiry sweep runs on.
--
-- One CREATE and one CREATE INDEX on `transactions`. No existing column is altered and no row is
-- rewritten: an index changes how rows are found, never what they contain, and it is the difference
-- between the nightly sweep reading a handful of listings and reading the whole table.
--
-- To reverse:
--   DROP TABLE "transaction_reminders";
--   DROP INDEX "transactions_listing_expiry_date_idx";

CREATE TABLE "transaction_reminders" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "variant" VARCHAR(16),
    "scheduled_for" DATE NOT NULL,
    "days_remaining" INTEGER,
    "recipient" VARCHAR(255),
    "delivery_method" VARCHAR(16) NOT NULL,
    "delivery_status" VARCHAR(16) NOT NULL,
    "detail" TEXT,
    "subject" VARCHAR(255),
    "seen_at" TIMESTAMP(0),
    "created_at" TIMESTAMP(0),
    "company_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "transaction_reminders_pkey" PRIMARY KEY ("id")
);

-- Duplicate protection, enforced by the database rather than by the scheduler's own bookkeeping:
-- a second run on the same day cannot insert a second reminder for the same occurrence.
CREATE UNIQUE INDEX "transaction_reminders_txn_kind_day_method_key"
    ON "transaction_reminders"("transaction_id", "kind", "scheduled_for", "delivery_method");

CREATE INDEX "transaction_reminders_transaction_id_idx" ON "transaction_reminders"("transaction_id");
CREATE INDEX "transaction_reminders_kind_scheduled_for_idx" ON "transaction_reminders"("kind", "scheduled_for");
CREATE INDEX "transaction_reminders_recipient_seen_at_idx" ON "transaction_reminders"("recipient", "seen_at");
CREATE INDEX "transaction_reminders_company_id_idx" ON "transaction_reminders"("company_id");

ALTER TABLE "transaction_reminders"
    ADD CONSTRAINT "transaction_reminders_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- `closing_date` is already indexed; the expiry sweep needs the same for its own date.
CREATE INDEX "transactions_listing_expiry_date_idx" ON "transactions"("listing_expiry_date");
