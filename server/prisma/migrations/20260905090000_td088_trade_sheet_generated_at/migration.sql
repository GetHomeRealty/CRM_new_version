-- TD-088 — a record that the Trade Record Sheet was produced, separate from sending it.
--
-- The sheet is a RECO trade record: a brokerage under audit has to show it was produced for a
-- file, and the application could produce one on demand while carrying no evidence that it ever
-- had. `trade_sheet_sent_at` answers a different question — whether it was emailed to somebody —
-- and stays null on every deal whose sheet was produced and handed over in person or filed.
--
-- Nullable, with no default: null means "no sheet has been produced through this system", which is
-- the honest value for every deal that predates this column.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "trade_sheet_generated_at" TIMESTAMP(0);
