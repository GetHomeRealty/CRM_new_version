-- India builder database, stage 3 (17 Oct 2026): builders, their contacts, one agreement each.
-- CreateTable
CREATE TABLE "builders" (
    "id" SERIAL NOT NULL,
    "market" VARCHAR(8) NOT NULL DEFAULT 'IN',
    "name" VARCHAR(255) NOT NULL,
    "company_name" VARCHAR(255),
    "email" VARCHAR(255),
    "phone" VARCHAR(64),
    "website" VARCHAR(255),
    "address" TEXT,
    "notes" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "builders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "builder_contacts" (
    "id" SERIAL NOT NULL,
    "builder_id" INTEGER NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "name" VARCHAR(255),
    "phone" VARCHAR(64),
    "email" VARCHAR(255),
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "builder_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "builder_agreements" (
    "id" SERIAL NOT NULL,
    "builder_id" INTEGER NOT NULL,
    "start_date" DATE,
    "expiry_date" DATE,
    "commission_pct" DECIMAL(8,4),
    "payment_terms" TEXT,
    "file_path" VARCHAR(512),
    "file_name" VARCHAR(255),
    "file_uploaded_at" TIMESTAMP(0),
    "last_reminder_at" TIMESTAMP(0),
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "builder_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "builders_market_deleted_at_idx" ON "builders"("market", "deleted_at");

-- CreateIndex
CREATE INDEX "builder_contacts_builder_id_idx" ON "builder_contacts"("builder_id");

-- CreateIndex
CREATE UNIQUE INDEX "builder_agreements_builder_id_key" ON "builder_agreements"("builder_id");

-- CreateIndex
CREATE INDEX "builder_agreements_expiry_date_idx" ON "builder_agreements"("expiry_date");

-- AddForeignKey
ALTER TABLE "builder_contacts" ADD CONSTRAINT "builder_contacts_builder_id_fkey" FOREIGN KEY ("builder_id") REFERENCES "builders"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "builder_agreements" ADD CONSTRAINT "builder_agreements_builder_id_fkey" FOREIGN KEY ("builder_id") REFERENCES "builders"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

