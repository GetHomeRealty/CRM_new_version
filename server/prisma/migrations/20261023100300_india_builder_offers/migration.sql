-- Builder offers, stage 4 (17 Oct 2026): offers given by builders and their confirmation on deals.
-- CreateTable
CREATE TABLE "builder_project_offers" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "details" TEXT,
    "kind" VARCHAR(32) NOT NULL DEFAULT 'other',
    "value" DECIMAL(16,4),
    "from_unit" INTEGER,
    "starts_on" DATE,
    "ends_on" DATE,
    "proof_path" VARCHAR(512),
    "proof_name" VARCHAR(255),
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "builder_project_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "builder_offer_applications" (
    "id" SERIAL NOT NULL,
    "offer_id" INTEGER NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "unit_number" INTEGER,
    "agreed" TEXT NOT NULL,
    "agreed_value" DECIMAL(16,4),
    "applied_by_id" INTEGER,
    "applied_by" VARCHAR(255),
    "applied_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "builder_offer_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "builder_project_offers_project_id_deleted_at_idx" ON "builder_project_offers"("project_id", "deleted_at");

-- CreateIndex
CREATE INDEX "builder_offer_applications_transaction_id_idx" ON "builder_offer_applications"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "builder_offer_applications_offer_id_transaction_id_key" ON "builder_offer_applications"("offer_id", "transaction_id");

-- AddForeignKey
ALTER TABLE "builder_project_offers" ADD CONSTRAINT "builder_project_offers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "builder_projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "builder_offer_applications" ADD CONSTRAINT "builder_offer_applications_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "builder_project_offers"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "builder_offer_applications" ADD CONSTRAINT "builder_offer_applications_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

