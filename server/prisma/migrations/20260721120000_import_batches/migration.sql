-- Bulk transaction import batches: one row per uploaded file, with the validation summary
-- and the per-row error report (JSON) so a completed import stays auditable.
CREATE TABLE "import_batches" (
    "id" SERIAL NOT NULL,
    "batch_id" VARCHAR(64) NOT NULL,
    "file_name" VARCHAR(255),
    "uploaded_by" VARCHAR(255),
    "uploaded_by_id" INTEGER,
    "uploaded_at" TIMESTAMP(0),
    "completed_at" TIMESTAMP(0),
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "warning_rows" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(32) NOT NULL DEFAULT 'Validated',
    "errors" TEXT,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "import_batches_batch_id_key" ON "import_batches"("batch_id");
CREATE INDEX "import_batches_uploaded_at_idx" ON "import_batches"("uploaded_at");
