-- Who handles each deal in Documentation / in Accounting (Sai, 25 Oct 2026). Two new empty columns; nothing else changes.
ALTER TABLE "transactions" ADD COLUMN "doc_handler_id" INTEGER, ADD COLUMN "acct_handler_id" INTEGER;
