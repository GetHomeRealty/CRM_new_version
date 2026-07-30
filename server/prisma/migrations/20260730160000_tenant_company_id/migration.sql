-- Tenant column: every table the brokerage owns directly carries the company it belongs to.
--
-- Purely additive. `ADD COLUMN ... DEFAULT 1` fills every existing row with company 1, which is the
-- only brokerage this deployment has ever had (company_settings id 1, "GET HOME REALTY INC."), so no
-- row moves and no code that has not been told about tenants can notice.
--
-- The DEFAULT stays afterwards on purpose. It means an INSERT written before this migration existed
-- still lands somewhere valid rather than failing a NOT NULL, which is what makes it safe to add the
-- column ahead of the code that fills it in.
--
-- `meta_webhook_events` is the exception and is nullable: Meta posts a lead to us before anyone knows
-- whose it is, and NULL says "not yet resolved" rather than quietly attributing it to company 1. The
-- two rows already in the table predate that distinction and are company 1's, so they are backfilled.

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "crm_broadcasts" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "crm_email_log" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "crm_email_settings" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "crm_referral_codes" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "email_suppressions" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "export_jobs" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "import_batches" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "lead_tags" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "marketing_inventory" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "meta_webhook_events" ADD COLUMN     "company_id" INTEGER;

-- AlterTable
ALTER TABLE "personal_access_tokens" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "company_id" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "agents_company_id_idx" ON "agents"("company_id");

-- CreateIndex
CREATE INDEX "campaigns_company_id_idx" ON "campaigns"("company_id");

-- CreateIndex
CREATE INDEX "crm_broadcasts_company_id_idx" ON "crm_broadcasts"("company_id");

-- CreateIndex
CREATE INDEX "crm_email_log_company_id_idx" ON "crm_email_log"("company_id");

-- CreateIndex
CREATE INDEX "crm_email_settings_company_id_idx" ON "crm_email_settings"("company_id");

-- CreateIndex
CREATE INDEX "crm_referral_codes_company_id_idx" ON "crm_referral_codes"("company_id");

-- CreateIndex
CREATE INDEX "customers_company_id_idx" ON "customers"("company_id");

-- CreateIndex
CREATE INDEX "email_suppressions_company_id_idx" ON "email_suppressions"("company_id");

-- CreateIndex
CREATE INDEX "export_jobs_company_id_idx" ON "export_jobs"("company_id");

-- CreateIndex
CREATE INDEX "import_batches_company_id_idx" ON "import_batches"("company_id");

-- CreateIndex
CREATE INDEX "lead_tags_company_id_idx" ON "lead_tags"("company_id");

-- CreateIndex
CREATE INDEX "leads_company_id_idx" ON "leads"("company_id");

-- CreateIndex
CREATE INDEX "marketing_inventory_company_id_idx" ON "marketing_inventory"("company_id");

-- CreateIndex
CREATE INDEX "meta_webhook_events_company_id_idx" ON "meta_webhook_events"("company_id");

-- CreateIndex
CREATE INDEX "personal_access_tokens_company_id_idx" ON "personal_access_tokens"("company_id");

-- CreateIndex
CREATE INDEX "transactions_company_id_idx" ON "transactions"("company_id");

-- CreateIndex
CREATE INDEX "users_company_id_idx" ON "users"("company_id");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_email_settings" ADD CONSTRAINT "crm_email_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_referral_codes" ADD CONSTRAINT "crm_referral_codes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_email_log" ADD CONSTRAINT "crm_email_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_broadcasts" ADD CONSTRAINT "crm_broadcasts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meta_webhook_events" ADD CONSTRAINT "meta_webhook_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_inventory" ADD CONSTRAINT "marketing_inventory_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Existing webhook rows arrived when there was only one brokerage.
UPDATE "meta_webhook_events" SET "company_id" = 1 WHERE "company_id" IS NULL;
