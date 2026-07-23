-- Personal mail accounts: each user can connect their own SMTP account and send from their own
-- address. Existing accounts keep user_id = NULL, meaning they stay brokerage accounts managed
-- under admin Email Settings and act as the shared fallback sender. Purely additive.

ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "user_id" INTEGER;
CREATE INDEX IF NOT EXISTS "mail_accounts_user_id_idx" ON "mail_accounts"("user_id");
