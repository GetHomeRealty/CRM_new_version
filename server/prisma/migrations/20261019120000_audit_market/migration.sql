-- India desk (19 Oct 2026): the country of a history row that is not tied to a deal, so the Audit
-- Trail and the Recycle Bin's deletion history show each country only its own. Rows tied to a deal
-- take the deal's country instead. Everything written before India existed is Canada's.
ALTER TABLE "audit_logs" ADD COLUMN "market" VARCHAR(2);

UPDATE "audit_logs" SET "market" = 'CA'
 WHERE "transaction_id" IS NULL AND "category" IN ('Invoice', 'Recycle Bin');
