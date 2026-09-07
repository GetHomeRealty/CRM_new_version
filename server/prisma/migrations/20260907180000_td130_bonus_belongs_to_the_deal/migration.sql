-- TD-130 (revised). THE BUILDER BONUS BELONGS TO THE DEAL, NOT TO ITS TERMS.
--
-- The brokerage's direction, and the better arithmetic: the terms divide a fee that already
-- includes the bonus, so a bonus can never push the terms past their own deal. When the terms
-- carried it, reference deal 300001 - 650,000 at 2% with a 480 bonus, fee 13,480 - was refused
-- for exceeding a master computed from its percentage alone.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "precon_comm_bonus" DECIMAL(15,2);

-- precon_terms.bonus, added earlier the same day, is NOT dropped here. Dropping it mid-change is
-- what took the transaction screen down for ten minutes on 2026-09-07: the previous build still
-- read the column, so restoring that build could not restore service. Add columns freely; drop one
-- only once the new code has proved itself. It is unused and harmless where it is.
