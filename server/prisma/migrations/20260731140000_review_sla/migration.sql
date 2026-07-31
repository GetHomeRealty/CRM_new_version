-- Reminder ladder for open review items.
--
-- Touches only `transaction_reviews`, the table added by 20260731090000. Both columns have
-- defaults, so existing rows are valid the moment they are added and no backfill is needed —
-- every current row reads as "no reminder sent yet", which is true.
--
-- To reverse:
--   ALTER TABLE "transaction_reviews" DROP COLUMN "sla_stage", DROP COLUMN "sla_notified_at";

ALTER TABLE "transaction_reviews" ADD COLUMN "sla_stage" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "transaction_reviews" ADD COLUMN "sla_notified_at" TIMESTAMP(0);

-- The sweep asks for open rejections that have not yet had the reminder they are due, oldest
-- first. Without this it scans the whole table every hour for what is usually an empty answer.
CREATE INDEX "transaction_reviews_resolution_status_sla_stage_idx"
    ON "transaction_reviews"("resolution_status", "sla_stage");
