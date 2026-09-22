-- Existing uploads remain submitted; only future agent uploads populate this column.
ALTER TABLE "documents" ADD COLUMN "draft_files" TEXT;
