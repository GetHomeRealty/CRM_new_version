-- India builder projects, stage 3b (17 Oct 2026): projects, their files and price history, and the
-- optional link from an India deal to its project. Canada untouched (new column is nullable).
-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "builder_project_id" INTEGER;

-- CreateTable
CREATE TABLE "builder_projects" (
    "id" SERIAL NOT NULL,
    "builder_id" INTEGER NOT NULL,
    "market" VARCHAR(8) NOT NULL DEFAULT 'IN',
    "name" VARCHAR(255) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'Coming Soon',
    "home_types" VARCHAR(255),
    "state" VARCHAR(128),
    "city" VARCHAR(128),
    "locality" VARCHAR(255),
    "address" TEXT,
    "overview" TEXT,
    "starting_price" DECIMAL(16,2),
    "max_price" DECIMAL(16,2),
    "bedrooms" VARCHAR(64),
    "occupancy" VARCHAR(64),
    "commission_pct" DECIMAL(8,4),
    "rera_number" VARCHAR(128),
    "rera_approved_on" DATE,
    "rera_valid_until" DATE,
    "rera_last_reminder_at" TIMESTAMP(0),
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "builder_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "builder_project_files" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "file_path" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "note" VARCHAR(500),
    "uploaded_by_id" INTEGER,
    "uploaded_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "builder_project_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "builder_project_prices" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "changed_on" DATE NOT NULL,
    "starting_price" DECIMAL(16,2),
    "note" VARCHAR(1000),
    "file_id" INTEGER,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "builder_project_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "builder_projects_builder_id_idx" ON "builder_projects"("builder_id");

-- CreateIndex
CREATE INDEX "builder_projects_market_deleted_at_idx" ON "builder_projects"("market", "deleted_at");

-- CreateIndex
CREATE INDEX "builder_projects_rera_valid_until_idx" ON "builder_projects"("rera_valid_until");

-- CreateIndex
CREATE INDEX "builder_project_files_project_id_kind_idx" ON "builder_project_files"("project_id", "kind");

-- CreateIndex
CREATE INDEX "builder_project_prices_project_id_changed_on_idx" ON "builder_project_prices"("project_id", "changed_on");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_builder_project_id_fkey" FOREIGN KEY ("builder_project_id") REFERENCES "builder_projects"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "builder_projects" ADD CONSTRAINT "builder_projects_builder_id_fkey" FOREIGN KEY ("builder_id") REFERENCES "builders"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "builder_project_files" ADD CONSTRAINT "builder_project_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "builder_projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "builder_project_prices" ADD CONSTRAINT "builder_project_prices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "builder_projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

