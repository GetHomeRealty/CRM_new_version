CREATE TABLE "client_review_requests" (
 "id" SERIAL PRIMARY KEY,
 "owner_user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "transaction_id" INTEGER NOT NULL REFERENCES "transactions"("id") ON DELETE CASCADE,
 "client_id" INTEGER NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
 "submission_id" UUID NOT NULL,
 "token_hash" VARCHAR(64) NOT NULL UNIQUE,
 "link_ciphertext" TEXT NOT NULL,
 "client_name" VARCHAR(255) NOT NULL,
 "client_email" VARCHAR(255) NOT NULL,
 "status" VARCHAR(16) NOT NULL DEFAULT 'ready' CHECK ("status" IN ('ready','sending','sent','uncertain','submitted','cancelled')),
 "rating" INTEGER CHECK ("rating" BETWEEN 1 AND 5),
 "comment" VARCHAR(5000),
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expires_at" TIMESTAMPTZ(3) NOT NULL,
 "submitted_at" TIMESTAMPTZ(3),
 UNIQUE ("owner_user_id", "submission_id")
);
CREATE INDEX "client_review_requests_owner_user_id_id_idx" ON "client_review_requests"("owner_user_id", "id");
