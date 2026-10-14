CREATE TABLE "campaign_submissions" (
  "user_id" INTEGER NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "campaign_id" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campaign_submissions_pkey" PRIMARY KEY ("user_id", "request_key")
);
-- No cascading foreign key: receipts must survive campaign deletion.
