-- The deal's total agent commission with HST, cached beside the payment figures.
--
-- WHY. `transaction-payment-status` classifies every deal through a ladder whose first real test is
-- "is the agent commission zero?", so answering the report needed the whole commission chain for
-- every matching deal. It was the last report with no fast path: 10.3 s at 80,000 deals, and it
-- exhausted the default Node heap doing it.
--
-- NULLABLE WITH NO DEFAULT, like its neighbours: NULL means "not computed", which readers treat as
-- "run the commission engine for this row" rather than as zero. Zero is a real and meaningful value
-- here -- it is what makes a deal "Not Applicable" -- so conflating the two would misclassify every
-- un-backfilled row.
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "calc_agent_comm_total" DECIMAL(15,2);
