-- Threaded conversation on a review item, attachments for the evidence, and the first-response
-- stamp the performance figures are computed from.
--
-- One ALTER, on `transaction_reviews` — the table added by 20260731090000 — and two CREATEs.
-- Nothing outside the review feature is touched. The new column is nullable, so every existing row
-- is valid the moment it is added and reads as "nobody has responded yet", which is true.
--
-- To reverse:
--   DROP TABLE "transaction_review_attachments";
--   DROP TABLE "transaction_review_messages";
--   ALTER TABLE "transaction_reviews" DROP COLUMN "first_response_at";

ALTER TABLE "transaction_reviews" ADD COLUMN "first_response_at" TIMESTAMP(0);

CREATE TABLE "transaction_review_messages" (
    "id" SERIAL NOT NULL,
    "review_id" INTEGER NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "author" VARCHAR(255),
    "author_role" VARCHAR(32),
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    "company_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "transaction_review_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transaction_review_attachments" (
    "id" SERIAL NOT NULL,
    "review_id" INTEGER,
    "message_id" INTEGER,
    "filename" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(128) NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaded_by" VARCHAR(255),
    "created_at" TIMESTAMP(0),
    "company_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "transaction_review_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transaction_review_messages_review_id_idx" ON "transaction_review_messages"("review_id");
CREATE INDEX "transaction_review_messages_transaction_id_idx" ON "transaction_review_messages"("transaction_id");
CREATE INDEX "transaction_review_messages_company_id_idx" ON "transaction_review_messages"("company_id");
CREATE INDEX "transaction_review_attachments_review_id_idx" ON "transaction_review_attachments"("review_id");
CREATE INDEX "transaction_review_attachments_message_id_idx" ON "transaction_review_attachments"("message_id");
CREATE INDEX "transaction_review_attachments_company_id_idx" ON "transaction_review_attachments"("company_id");

-- Cascade from the review: a deal that is truly deleted takes its reviews, and a review takes its
-- conversation and its evidence. Nothing here is reachable once its parent is gone.
ALTER TABLE "transaction_review_messages"
    ADD CONSTRAINT "transaction_review_messages_review_id_fkey"
    FOREIGN KEY ("review_id") REFERENCES "transaction_reviews"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "transaction_review_attachments"
    ADD CONSTRAINT "transaction_review_attachments_review_id_fkey"
    FOREIGN KEY ("review_id") REFERENCES "transaction_reviews"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "transaction_review_attachments"
    ADD CONSTRAINT "transaction_review_attachments_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "transaction_review_messages"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
