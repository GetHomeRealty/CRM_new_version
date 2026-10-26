-- India deals: down payment Yes/No and its number (Sai, 26 Oct 2026). Three new empty columns; nothing else changes.
ALTER TABLE "transactions" ADD COLUMN "india_down_payment" VARCHAR(3), ADD COLUMN "india_down_payment_value" DECIMAL(16,2), ADD COLUMN "india_down_payment_kind" VARCHAR(12);
