-- Delivery status on an outbound SMS: sent | read | failed. NULL on an inbound message.
--
-- Set by hand, not by a delivery receipt: the app has no SMS gateway, and plain SMS carries no
-- read receipt even where a gateway exists. Nullable and additive, so existing rows are valid
-- as they stand; the backfill below only labels the outbound ones already recorded.

ALTER TABLE "lead_messages" ADD COLUMN IF NOT EXISTS "status" VARCHAR(16);

UPDATE "lead_messages" SET "status" = 'sent' WHERE "direction" = 'outbound' AND "status" IS NULL;
