-- Automatic retry for reminder emails that failed for a transient reason.
--
-- Three defaulted or nullable columns on `transaction_reminders`, the table added by
-- 20260731200000, and one index. Existing rows read as "one attempt, nothing scheduled", which is
-- true of every reminder sent before this existed.
--
-- To reverse:
--   ALTER TABLE "transaction_reminders"
--     DROP COLUMN "attempts", DROP COLUMN "next_retry_at", DROP COLUMN "last_attempt_at";

ALTER TABLE "transaction_reminders" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "transaction_reminders" ADD COLUMN "next_retry_at" TIMESTAMP(0);
ALTER TABLE "transaction_reminders" ADD COLUMN "last_attempt_at" TIMESTAMP(0);

-- The retry pass asks for rows whose next attempt is due. Only a failed row ever carries a date
-- here, so the index stays the size of the backlog rather than the size of the table.
CREATE INDEX "transaction_reminders_next_retry_at_idx" ON "transaction_reminders"("next_retry_at");
