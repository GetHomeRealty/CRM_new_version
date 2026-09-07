-- TD-130. A preconstruction term can hold a fixed amount, and a builder bonus.
--
-- The master already has two routes to a fee (precon_comm_pct or precon_comm_amt_manual);
-- a term had only the percentage. 382 of the brokerage's 430 preconstruction deals carry a
-- flat fee or a percentage plus a round builder bonus, and no term percentage can reproduce
-- either: 7,500 of 859,900 is 0.8721944412...%, which Decimal(8,4) cannot hold, so the
-- stored 0.8722% reads back as 7,500.05 and two terms exceed their 15,000 master.
--
-- BOTH COLUMNS ARE NULLABLE ON PURPOSE. Every existing row keeps amt and bonus NULL and
-- therefore keeps computing exactly as it does today. amt IS NOT NULL is what marks a term
-- as amount-driven, mirroring how precon_comm_amt_manual already marks the master.
ALTER TABLE "precon_terms" ADD COLUMN "amt" DECIMAL(15,2);
ALTER TABLE "precon_terms" ADD COLUMN "bonus" DECIMAL(15,2);
