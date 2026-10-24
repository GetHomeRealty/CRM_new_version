-- India deals: how the buyer pays (Sai, 24 Oct 2026). One new empty column; nothing else changes.
ALTER TABLE "transactions" ADD COLUMN "india_payment" VARCHAR(20);
