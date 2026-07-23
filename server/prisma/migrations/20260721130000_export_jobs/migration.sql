-- Export & Download Centre: queued/processed bulk exports with expiring secure links.
CREATE TABLE "export_jobs" (
    "id" SERIAL NOT NULL,
    "export_id" VARCHAR(64) NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "action_type" VARCHAR(48) NOT NULL,
    "format" VARCHAR(16) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'Queued',
    "transaction_count" INTEGER NOT NULL DEFAULT 0,
    "document_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "file_name" VARCHAR(255),
    "file_path" VARCHAR(255),
    "file_size" INTEGER,
    "filters" TEXT,
    "selection" TEXT,
    "request_hash" VARCHAR(64),
    "requested_by" VARCHAR(255),
    "requested_by_id" INTEGER,
    "requested_at" TIMESTAMP(0),
    "started_at" TIMESTAMP(0),
    "completed_at" TIMESTAMP(0),
    "expires_at" TIMESTAMP(0),
    "download_status" VARCHAR(24) NOT NULL DEFAULT 'Not Downloaded',
    "downloaded_at" TIMESTAMP(0),
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "export_jobs_export_id_key" ON "export_jobs"("export_id");
CREATE UNIQUE INDEX "export_jobs_token_key" ON "export_jobs"("token");
CREATE INDEX "export_jobs_requested_by_id_idx" ON "export_jobs"("requested_by_id");
CREATE INDEX "export_jobs_status_idx" ON "export_jobs"("status");
CREATE INDEX "export_jobs_requested_at_idx" ON "export_jobs"("requested_at");
