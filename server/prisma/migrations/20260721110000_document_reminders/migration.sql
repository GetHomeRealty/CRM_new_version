-- Documentation reminder log + session-store table.
--
-- `user_sessions` is created at runtime by connect-pg-simple, so it already exists on any
-- environment that has booted the API. It is declared here with IF NOT EXISTS purely so the
-- migration history matches the schema (it was previously untracked drift) — running this
-- migration must never drop or recreate live session data.
CREATE TABLE IF NOT EXISTS "user_sessions" (
    "sid" VARCHAR NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions"("expire");

-- One row per document per recipient per reminder. Consolidated sends ("all pending
-- documents in this deal") share a batch_id so the same action can be reported either as a
-- single reminder or as its individual documents.
CREATE TABLE "document_reminders" (
    "id" SERIAL NOT NULL,
    "batch_id" VARCHAR(64),
    "transaction_id" INTEGER NOT NULL,
    "document_id" INTEGER,
    "document_name" VARCHAR(255),
    "document_status" VARCHAR(32),
    "reminder_type" VARCHAR(32) NOT NULL,
    "channel" VARCHAR(32) NOT NULL DEFAULT 'email',
    "recipient" VARCHAR(255),
    "recipient_name" VARCHAR(255),
    "sent_by" VARCHAR(255),
    "sent_by_id" INTEGER,
    "sent_at" TIMESTAMP(0),
    "delivery_status" VARCHAR(32) NOT NULL DEFAULT 'Sent',
    "failure_reason" TEXT,
    "message" TEXT,
    "document_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    CONSTRAINT "document_reminders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "document_reminders_transaction_id_idx" ON "document_reminders"("transaction_id");
CREATE INDEX "document_reminders_document_id_idx" ON "document_reminders"("document_id");
CREATE INDEX "document_reminders_sent_at_idx" ON "document_reminders"("sent_at");
CREATE INDEX "document_reminders_batch_id_idx" ON "document_reminders"("batch_id");

ALTER TABLE "document_reminders"
    ADD CONSTRAINT "document_reminders_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
