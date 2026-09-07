-- TD-142 — a bulk import that can be undone.
--
-- An import can create hundreds of deals in one press, and the only ways back were roughly a
-- thousand deliberate clicks — the trash icon on each row, then Delete forever in the Recycle Bin —
-- or SQL against production. The brokerage is preparing to migrate 495 historic deals in one
-- action, so the cost of a wrong agent mapping or a misread column is exactly that.
--
-- THE ENTRY ASSUMES THIS COLUMN ALREADY EXISTS. It says "the batch id is already stored against
-- every row it created", and it is not: `import_batches` records the batch, and nothing on the
-- transaction points back at it. So the undo it prefers — reversing one batch rather than a
-- selection — needs the link first. That is what this adds.
--
-- WHY THE BATCH AND NOT A BULK DELETE ON THE SELECTION, which was the other option offered: a batch
-- cannot catch a deal somebody entered by hand in between, and it needs no judgement at the moment
-- of use. A bulk delete over an arbitrary selection is a more dangerous control for the same job.
--
-- NULLABLE, and indexed rather than unique — one batch owns many rows. Every deal created before
-- this keeps null and is therefore not reversible by batch, which is the honest position: nothing
-- recorded which import made them.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "import_batch_id" VARCHAR(64);

-- The undo reads by batch, and so does the count shown beside it.
CREATE INDEX IF NOT EXISTS "transactions_import_batch_id_idx" ON "transactions"("import_batch_id");
