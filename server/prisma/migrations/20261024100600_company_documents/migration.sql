-- Company Documents (19 Oct 2026): each country's company certificates and documents (every file
-- version kept) and its stakeholders / partners with their own files. Super Admin only; Canada and
-- India kept apart by "market".
CREATE TABLE "company_documents" (
    "id" SERIAL NOT NULL,
    "market" VARCHAR(8) NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "number" VARCHAR(128),
    "issued_by" VARCHAR(255),
    "holder" VARCHAR(255),
    "contact_name" VARCHAR(255),
    "contact_phone" VARCHAR(64),
    "contact_email" VARCHAR(255),
    "issue_date" DATE,
    "expiry_date" DATE,
    "notes" TEXT,
    "reminder_started_at" TIMESTAMP(0),
    "last_reminder_at" TIMESTAMP(0),
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "company_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "company_document_files" (
    "id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "file_path" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "note" VARCHAR(500),
    "uploaded_by_id" INTEGER,
    "uploaded_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "company_document_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "company_stakeholders" (
    "id" SERIAL NOT NULL,
    "market" VARCHAR(8) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "role" VARCHAR(32) NOT NULL DEFAULT 'Other',
    "share_pct" DECIMAL(7,4),
    "phone" VARCHAR(64),
    "email" VARCHAR(255),
    "address" TEXT,
    "id_details" JSONB NOT NULL DEFAULT '[]',
    "joined_on" DATE,
    "left_on" DATE,
    "notes" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "company_stakeholders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "company_stakeholder_files" (
    "id" SERIAL NOT NULL,
    "stakeholder_id" INTEGER NOT NULL,
    "file_path" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "note" VARCHAR(500),
    "uploaded_by_id" INTEGER,
    "uploaded_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "company_stakeholder_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "company_documents_market_deleted_at_idx" ON "company_documents"("market", "deleted_at");
CREATE INDEX "company_documents_expiry_date_idx" ON "company_documents"("expiry_date");
CREATE INDEX "company_document_files_document_id_idx" ON "company_document_files"("document_id");
CREATE INDEX "company_stakeholders_market_deleted_at_idx" ON "company_stakeholders"("market", "deleted_at");
CREATE INDEX "company_stakeholder_files_stakeholder_id_idx" ON "company_stakeholder_files"("stakeholder_id");

ALTER TABLE "company_document_files" ADD CONSTRAINT "company_document_files_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "company_documents"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "company_stakeholder_files" ADD CONSTRAINT "company_stakeholder_files_stakeholder_id_fkey" FOREIGN KEY ("stakeholder_id") REFERENCES "company_stakeholders"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
