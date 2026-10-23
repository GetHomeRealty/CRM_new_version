-- India desk, stage 1 (16 Oct 2026): every deal belongs to one country, every user may work in a
-- listed set of countries. Existing rows become Canada; nobody has India access until it is given.
-- Both columns have a constant default, so on PostgreSQL 11+ this is a metadata-only change: no
-- table rewrite, no long lock.
ALTER TABLE "transactions" ADD COLUMN "market" VARCHAR(8) NOT NULL DEFAULT 'CA';
CREATE INDEX "transactions_market_idx" ON "transactions"("market");
ALTER TABLE "users" ADD COLUMN "markets" VARCHAR(64) NOT NULL DEFAULT 'CA';
