-- Transaction Review & Resolution: a permanent record of every decision an administrator makes
-- about an agent's change, and of how that issue was put right afterwards.
--
-- CREATE only. No existing table is altered and no existing row is read or written, so this applies
-- to a live database without touching transaction data. To reverse it:
--   DROP TABLE "transaction_reviews";
-- Nothing else references the table, so the drop is complete and leaves the schema as it was.

CREATE TABLE "transaction_reviews" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "audit_log_id" INTEGER,
    "decision" VARCHAR(16) NOT NULL,
    "reason" TEXT,
    "field_label" VARCHAR(255),
    "old_value" TEXT,
    "new_value" TEXT,
    "agent_name" VARCHAR(255),
    "actor_name" VARCHAR(255),
    "auto_reverted" BOOLEAN NOT NULL DEFAULT false,
    "auto_revert_result" VARCHAR(255),
    "resolution_status" VARCHAR(16) NOT NULL DEFAULT 'Open',
    "corrected_at" TIMESTAMP(0),
    "corrected_by" VARCHAR(255),
    "resolved_at" TIMESTAMP(0),
    "resolved_by" VARCHAR(255),
    "agent_seen_at" TIMESTAMP(0),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    "company_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "transaction_reviews_pkey" PRIMARY KEY ("id")
);

-- The panel reads by transaction, newest first, and filters on resolution status; the composite
-- index serves "what is still open on this deal", which is the question asked most often.
CREATE INDEX "transaction_reviews_transaction_id_idx" ON "transaction_reviews"("transaction_id");
CREATE INDEX "transaction_reviews_created_at_idx" ON "transaction_reviews"("created_at");
CREATE INDEX "transaction_reviews_resolution_status_idx" ON "transaction_reviews"("resolution_status");
CREATE INDEX "transaction_reviews_transaction_id_resolution_status_idx" ON "transaction_reviews"("transaction_id", "resolution_status");
CREATE INDEX "transaction_reviews_company_id_idx" ON "transaction_reviews"("company_id");

-- Cascade matches every other child of a transaction: a deal that is truly gone takes its review
-- history with it, and the Recycle Bin's soft delete never reaches this.
ALTER TABLE "transaction_reviews"
    ADD CONSTRAINT "transaction_reviews_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
