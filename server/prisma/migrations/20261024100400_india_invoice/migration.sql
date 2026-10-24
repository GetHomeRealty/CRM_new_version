-- India invoice (19 Oct 2026): India settings, builder GST details, the invoicing office on India deals.
-- AlterTable
ALTER TABLE "builders" ADD COLUMN     "billing_address" TEXT,
ADD COLUMN     "gstin" VARCHAR(32),
ADD COLUMN     "state" VARCHAR(64);

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "india_settings" JSONB;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "india_office" VARCHAR(8);

