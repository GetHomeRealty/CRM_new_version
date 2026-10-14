CREATE TABLE "document_reminder_receipts" (
 "id" SERIAL PRIMARY KEY,
 "owner_user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "transaction_id" INTEGER NOT NULL REFERENCES "transactions"("id") ON DELETE CASCADE,
 "request_id" UUID NOT NULL,
 "version" VARCHAR(64) NOT NULL,
 "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('sending','sent','uncertain')),
 "document_count" INTEGER NOT NULL CHECK ("document_count" BETWEEN 1 AND 200),
 "recipient_count" INTEGER NOT NULL CHECK ("recipient_count" BETWEEN 1 AND 50),
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "document_reminder_receipts_owner_user_id_request_id_key" UNIQUE ("owner_user_id","request_id")
);
CREATE INDEX "document_reminder_receipts_transaction_id_idx" ON "document_reminder_receipts"("transaction_id");
