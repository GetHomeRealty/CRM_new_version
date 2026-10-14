-- No foreign keys: receipts must survive message/account deletion to prevent replay.
CREATE TABLE "inbox_reply_submissions" (
  "user_id" INTEGER NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "message_id" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbox_reply_submissions_pkey" PRIMARY KEY ("user_id", "request_key"),
  CONSTRAINT "inbox_reply_submissions_status_check" CHECK ("status" IN ('pending', 'accepted', 'uncertain'))
);
