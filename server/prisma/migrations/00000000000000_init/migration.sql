-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "agents" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(255),
    "is_team" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "category" VARCHAR(255),
    "transaction_id" INTEGER,
    "who" VARCHAR(255),
    "user_id" INTEGER,
    "section" VARCHAR(255),
    "field" VARCHAR(255),
    "old_value" TEXT,
    "new_value" TEXT,
    "action" VARCHAR(255),
    "source" VARCHAR(255),
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "details" TEXT,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brokerage_agents" (
    "id" SERIAL NOT NULL,
    "brokerage_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "brokerage_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brokerages" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "name" VARCHAR(255),
    "address" VARCHAR(255),
    "email" VARCHAR(255),
    "invoice_email" VARCHAR(255),
    "agent_email" VARCHAR(255),
    "phone" VARCHAR(255),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "brokerages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cache" (
    "key" VARCHAR(255) NOT NULL,
    "value" TEXT NOT NULL,
    "expiration" INTEGER NOT NULL,

    CONSTRAINT "cache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "cache_locks" (
    "key" VARCHAR(255) NOT NULL,
    "owner" VARCHAR(255) NOT NULL,
    "expiration" INTEGER NOT NULL,

    CONSTRAINT "cache_locks_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "client_identifications" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "client_name" VARCHAR(255) NOT NULL,
    "full_legal_name" TEXT,
    "address" TEXT,
    "dob" TEXT,
    "occupation" TEXT,
    "id_type" TEXT,
    "id_number" TEXT,
    "issuing_jurisdiction" TEXT,
    "country" TEXT,
    "expiry_date" TEXT,
    "source" VARCHAR(255) NOT NULL DEFAULT 'extracted',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "extracted_at" TIMESTAMP(0),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "client_identifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(255),
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_settings" (
    "id" SERIAL NOT NULL,
    "feature_flags" TEXT,
    "name" VARCHAR(255) NOT NULL DEFAULT 'GetHomeRealty INC',
    "address" VARCHAR(255),
    "phone" VARCHAR(255),
    "email" VARCHAR(255),
    "logo_path" VARCHAR(255),
    "hst_number" VARCHAR(255),
    "bank_beneficiary" VARCHAR(255),
    "bank_name" VARCHAR(255),
    "transit_no" VARCHAR(255),
    "account_no" VARCHAR(255),
    "institution_no" VARCHAR(255),
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CAD',
    "default_tax_rate" DECIMAL(6,2) NOT NULL DEFAULT 13.00,
    "invoice_prefix" VARCHAR(255) NOT NULL DEFAULT 'INV-',
    "next_invoice_no" INTEGER NOT NULL DEFAULT 601107,
    "default_terms" VARCHAR(255) NOT NULL DEFAULT 'Due on Receipt',
    "thank_you_note" TEXT,
    "deposit_heading" TEXT,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conditions" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "type" VARCHAR(255) NOT NULL DEFAULT 'Financing',
    "custom_name" VARCHAR(255),
    "deadline" DATE,
    "status" VARCHAR(255) NOT NULL DEFAULT 'Pending',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "address" VARCHAR(255),
    "city" VARCHAR(255),
    "province" VARCHAR(255),
    "postal_code" VARCHAR(255),
    "country" VARCHAR(255) NOT NULL DEFAULT 'Canada',
    "email" VARCHAR(255),
    "phone" VARCHAR(255),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "is_condition" BOOLEAN NOT NULL DEFAULT false,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "condition_id" INTEGER,
    "status" VARCHAR(255) NOT NULL DEFAULT 'Pending',
    "reminder" BOOLEAN NOT NULL DEFAULT false,
    "agent_accepted" VARCHAR(255),
    "pending_delete" BOOLEAN NOT NULL DEFAULT false,
    "deleted_by" VARCHAR(255),
    "validation" VARCHAR(255) NOT NULL DEFAULT 'Pending',
    "drive_uploaded" VARCHAR(255),
    "remarks" TEXT,
    "file_name" VARCHAR(255),
    "file_path" VARCHAR(255),
    "files" TEXT,
    "validation_file_name" VARCHAR(255),
    "validation_file_path" VARCHAR(255),
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "id" SERIAL NOT NULL,
    "event_key" VARCHAR(255) NOT NULL,
    "module" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "body_html" TEXT NOT NULL,
    "mail_account_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "failed_jobs" (
    "id" SERIAL NOT NULL,
    "uuid" VARCHAR(255) NOT NULL,
    "connection" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "exception" TEXT NOT NULL,
    "failed_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failed_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inter_board_listings" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "name" VARCHAR(255),
    "board_id" VARCHAR(255),
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "inter_board_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "row_no" INTEGER NOT NULL DEFAULT 1,
    "description" VARCHAR(255) NOT NULL,
    "qty" DECIMAL(12,2) NOT NULL DEFAULT 1.00,
    "rate" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "amount" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "is_taxable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "paid_on" DATE NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "method" VARCHAR(255),
    "reference" VARCHAR(255),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" SERIAL NOT NULL,
    "invoice_no" VARCHAR(255) NOT NULL,
    "transaction_id" INTEGER,
    "source" VARCHAR(20) NOT NULL DEFAULT 'manual',
    "transaction_type" VARCHAR(255),
    "term_no" INTEGER,
    "created_by" INTEGER,
    "property_reference" VARCHAR(255),
    "customer_id" INTEGER,
    "customer_name" VARCHAR(255),
    "customer_phone" VARCHAR(255),
    "customer_email" VARCHAR(255),
    "customer_address" VARCHAR(255),
    "customer_city" VARCHAR(255),
    "customer_province" VARCHAR(255),
    "customer_postal_code" VARCHAR(255),
    "customer_country" VARCHAR(255) NOT NULL DEFAULT 'Canada',
    "invoice_date" DATE NOT NULL,
    "terms" VARCHAR(255) NOT NULL DEFAULT 'Due on Receipt',
    "due_date" DATE,
    "trade_number" VARCHAR(255),
    "listing_agent" VARCHAR(255),
    "coop_salesperson" VARCHAR(255),
    "subject" TEXT,
    "status" VARCHAR(255) NOT NULL DEFAULT 'Draft',
    "delete_reason" VARCHAR(1000),
    "sent_at" TIMESTAMP(0),
    "sub_total" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "tax_total" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "total" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "tax_rate" DECIMAL(5,2),
    "commission_received_date" DATE,
    "commission_received_via" VARCHAR(255),
    "reminders" TEXT,
    "auto_reminder" TEXT,
    "customer_notes" TEXT,
    "terms_conditions" TEXT,
    "signature_path" TEXT,
    "broker_name" VARCHAR(255),
    "amount_paid" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "balance_due" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_batches" (
    "id" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "total_jobs" INTEGER NOT NULL,
    "pending_jobs" INTEGER NOT NULL,
    "failed_jobs" INTEGER NOT NULL,
    "failed_job_ids" TEXT NOT NULL,
    "options" TEXT,
    "cancelled_at" INTEGER,
    "created_at" INTEGER NOT NULL,
    "finished_at" INTEGER,

    CONSTRAINT "job_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" SERIAL NOT NULL,
    "queue" VARCHAR(255) NOT NULL,
    "payload" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "reserved_at" INTEGER,
    "available_at" INTEGER NOT NULL,
    "created_at" INTEGER NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_accounts" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "from_name" VARCHAR(255),
    "from_email" VARCHAR(255) NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 587,
    "username" VARCHAR(255),
    "password" TEXT,
    "encryption" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "mail_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migrations" (
    "id" SERIAL NOT NULL,
    "migration" VARCHAR(255) NOT NULL,
    "batch" INTEGER NOT NULL,

    CONSTRAINT "migrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "email" VARCHAR(255) NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(0),

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "personal_access_tokens" (
    "id" SERIAL NOT NULL,
    "tokenable_type" VARCHAR(255) NOT NULL,
    "tokenable_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "abilities" TEXT,
    "last_used_at" TIMESTAMP(0),
    "expires_at" TIMESTAMP(0),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "personal_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "precon_terms" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "term_no" INTEGER NOT NULL,
    "pct" DECIMAL(8,4),
    "closing_date" DATE,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "precon_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" VARCHAR(255) NOT NULL,
    "user_id" INTEGER,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "payload" TEXT NOT NULL,
    "last_activity" INTEGER NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_member_terms" (
    "id" SERIAL NOT NULL,
    "team_member_id" INTEGER NOT NULL,
    "term_no" INTEGER NOT NULL,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "team_member_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "split" DECIMAL(8,4) NOT NULL DEFAULT 0.0000,
    "agent_pct" DECIMAL(8,4) NOT NULL DEFAULT 90.0000,
    "brok_pct" DECIMAL(8,4) NOT NULL DEFAULT 10.0000,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "access" VARCHAR(255) NOT NULL DEFAULT 'docs',
    "scope" VARCHAR(255) NOT NULL DEFAULT 'Entire',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_delete_requests" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "requested_by" INTEGER,
    "requested_by_name" VARCHAR(255),
    "reason" TEXT,
    "status" VARCHAR(255) NOT NULL DEFAULT 'pending',
    "forwarded_by" INTEGER,
    "forwarded_by_name" VARCHAR(255),
    "forward_reason" TEXT,
    "reviewed_by" INTEGER,
    "reviewed_by_name" VARCHAR(255),
    "reviewed_at" TIMESTAMP(0),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "transaction_delete_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_edit_requests" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "status_at_request" VARCHAR(255),
    "scope" VARCHAR(255),
    "requested_by" INTEGER,
    "requested_by_name" VARCHAR(255),
    "reason" TEXT,
    "status" VARCHAR(255) NOT NULL DEFAULT 'pending',
    "reviewed_by" INTEGER,
    "reviewed_by_name" VARCHAR(255),
    "reviewed_at" TIMESTAMP(0),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "transaction_edit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_message_reads" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "last_read_at" TIMESTAMP(0),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "transaction_message_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_messages" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "author" VARCHAR(255),
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "transaction_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_snapshots" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "module" VARCHAR(255) NOT NULL,
    "data" TEXT,
    "who" VARCHAR(255),
    "user_id" INTEGER,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "transaction_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_statuses" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "status" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "transaction_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" SERIAL NOT NULL,
    "trade_no" VARCHAR(255) NOT NULL,
    "type" VARCHAR(255) NOT NULL,
    "property" VARCHAR(255),
    "agent" VARCHAR(255),
    "agent_review_at" TIMESTAMP(0),
    "price" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "deposit" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "offer_date" DATE,
    "closing_date" DATE,
    "listing_contract_date" DATE,
    "listing_expiry_date" DATE,
    "mls_type" VARCHAR(255) NOT NULL DEFAULT 'mls',
    "mls_num" VARCHAR(255),
    "mls_verified" BOOLEAN NOT NULL DEFAULT false,
    "comm_type" VARCHAR(255) NOT NULL DEFAULT '%',
    "comm_value" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "comm_pct" DECIMAL(8,4),
    "comm_amt" DECIMAL(15,2),
    "comm_adjust_enabled" BOOLEAN NOT NULL DEFAULT false,
    "comm_adjust_before" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "comm_adjust_after" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "listing_comm_pct" DECIMAL(8,4),
    "coop_comm_pct" DECIMAL(8,4),
    "listing_comm_flat" DECIMAL(15,2),
    "coop_comm_flat" DECIMAL(15,2),
    "trust_payable" DECIMAL(15,2),
    "listing_adj_enabled" BOOLEAN NOT NULL DEFAULT false,
    "listing_adj_before" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "listing_adj_after" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "coop_adj_enabled" BOOLEAN NOT NULL DEFAULT false,
    "coop_adj_before" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "coop_adj_after" DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    "precon_listing_type" VARCHAR(255) NOT NULL DEFAULT 'mls',
    "precon_term_count" INTEGER,
    "commission_agent" VARCHAR(255),
    "precon_net_of_hst" BOOLEAN NOT NULL DEFAULT false,
    "precon_comm_pct" DECIMAL(8,4),
    "precon_comm_amt_manual" DECIMAL(15,2),
    "precon_details_of_terms" VARCHAR(255) NOT NULL DEFAULT 'Entire',
    "builder_name" VARCHAR(255),
    "builder_vendor" VARCHAR(255),
    "builder_project" VARCHAR(255),
    "builder_address" VARCHAR(255),
    "builder_office_email" VARCHAR(255),
    "builder_invoice_email" VARCHAR(255),
    "builder_phone" VARCHAR(255),
    "lawyer_name" VARCHAR(255),
    "lawyer_email" VARCHAR(255),
    "lawyer_phone" VARCHAR(255),
    "lawyer_address" VARCHAR(255),
    "buyer_lawyer_name" VARCHAR(255),
    "buyer_lawyer_email" VARCHAR(255),
    "buyer_lawyer_phone" VARCHAR(255),
    "buyer_lawyer_address" VARCHAR(255),
    "seller_lawyer_name" VARCHAR(255),
    "seller_lawyer_email" VARCHAR(255),
    "seller_lawyer_phone" VARCHAR(255),
    "seller_lawyer_address" VARCHAR(255),
    "admin_activities" TEXT,
    "activity_tracker" TEXT,
    "adjustments" TEXT,
    "commercial_lease" TEXT,
    "notice_of_sale" TEXT,
    "comm_status" VARCHAR(255) NOT NULL DEFAULT 'Pending',
    "comm_paid_status" VARCHAR(255),
    "valid_status" VARCHAR(255) NOT NULL DEFAULT 'Pending',
    "conditional_offer" BOOLEAN NOT NULL DEFAULT false,
    "inter_board_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    "reco_audit_ready" VARCHAR(255),
    "reco_audit_remarks" TEXT,
    "trade_sheet_sent_at" TIMESTAMP(0),
    "trade_sheet_data" TEXT,
    "payment_type" VARCHAR(255),
    "listing_price" DECIMAL(15,2),
    "lead_source" VARCHAR(255),
    "lead_assigned_date" DATE,
    "lead_converted_date" DATE,
    "review_email_sent_at" TIMESTAMP(0),
    "review_received_at" TIMESTAMP(0),
    "gift_coupon_value" DECIMAL(15,2),
    "gift_coupon_issued_at" DATE,
    "deleted_at" TIMESTAMP(0),

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trashed_row_items" (
    "id" SERIAL NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "module" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(255) NOT NULL,
    "agent" VARCHAR(255),
    "term" INTEGER,
    "label" VARCHAR(500),
    "data" TEXT,
    "who" VARCHAR(255),
    "user_id" INTEGER,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "trashed_row_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permissions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "screen" VARCHAR(255) NOT NULL,
    "level" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "username" VARCHAR(255),
    "email" VARCHAR(255) NOT NULL,
    "role" VARCHAR(255) NOT NULL DEFAULT 'agent',
    "status" VARCHAR(255) NOT NULL DEFAULT 'Active',
    "profile" TEXT,
    "email_verified_at" TIMESTAMP(0),
    "password" VARCHAR(255) NOT NULL,
    "remember_token" VARCHAR(100),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_name_key" ON "agents"("name");

-- CreateIndex
CREATE INDEX "audit_logs_category_idx" ON "audit_logs"("category");

-- CreateIndex
CREATE INDEX "audit_logs_transaction_id_idx" ON "audit_logs"("transaction_id");

-- CreateIndex
CREATE INDEX "brokerage_agents_brokerage_id_idx" ON "brokerage_agents"("brokerage_id");

-- CreateIndex
CREATE UNIQUE INDEX "brokerages_transaction_id_key" ON "brokerages"("transaction_id");

-- CreateIndex
CREATE INDEX "cache_expiration_idx" ON "cache"("expiration");

-- CreateIndex
CREATE INDEX "cache_locks_expiration_idx" ON "cache_locks"("expiration");

-- CreateIndex
CREATE UNIQUE INDEX "client_identifications_transaction_id_client_name_key" ON "client_identifications"("transaction_id", "client_name");

-- CreateIndex
CREATE INDEX "clients_transaction_id_idx" ON "clients"("transaction_id");

-- CreateIndex
CREATE INDEX "conditions_transaction_id_idx" ON "conditions"("transaction_id");

-- CreateIndex
CREATE INDEX "documents_transaction_id_idx" ON "documents"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_event_key_key" ON "email_templates"("event_key");

-- CreateIndex
CREATE INDEX "email_templates_mail_account_id_idx" ON "email_templates"("mail_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "failed_jobs_uuid_key" ON "failed_jobs"("uuid");

-- CreateIndex
CREATE INDEX "inter_board_listings_transaction_id_idx" ON "inter_board_listings"("transaction_id");

-- CreateIndex
CREATE INDEX "invoice_line_items_invoice_id_idx" ON "invoice_line_items"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_payments_invoice_id_idx" ON "invoice_payments"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_no_key" ON "invoices"("invoice_no");

-- CreateIndex
CREATE INDEX "invoices_customer_id_idx" ON "invoices"("customer_id");

-- CreateIndex
CREATE INDEX "invoices_transaction_id_idx" ON "invoices"("transaction_id");

-- CreateIndex
CREATE INDEX "jobs_queue_idx" ON "jobs"("queue");

-- CreateIndex
CREATE UNIQUE INDEX "personal_access_tokens_token_key" ON "personal_access_tokens"("token");

-- CreateIndex
CREATE INDEX "personal_access_tokens_expires_at_idx" ON "personal_access_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "personal_access_tokens_tokenable_type_tokenable_id_idx" ON "personal_access_tokens"("tokenable_type", "tokenable_id");

-- CreateIndex
CREATE UNIQUE INDEX "precon_terms_transaction_id_term_no_key" ON "precon_terms"("transaction_id", "term_no");

-- CreateIndex
CREATE INDEX "sessions_last_activity_idx" ON "sessions"("last_activity");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_member_terms_team_member_id_term_no_key" ON "team_member_terms"("team_member_id", "term_no");

-- CreateIndex
CREATE INDEX "team_members_transaction_id_idx" ON "team_members"("transaction_id");

-- CreateIndex
CREATE INDEX "transaction_delete_requests_transaction_id_status_idx" ON "transaction_delete_requests"("transaction_id", "status");

-- CreateIndex
CREATE INDEX "transaction_edit_requests_transaction_id_idx" ON "transaction_edit_requests"("transaction_id");

-- CreateIndex
CREATE INDEX "transaction_message_reads_user_id_idx" ON "transaction_message_reads"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_message_reads_transaction_id_user_id_key" ON "transaction_message_reads"("transaction_id", "user_id");

-- CreateIndex
CREATE INDEX "transaction_messages_transaction_id_idx" ON "transaction_messages"("transaction_id");

-- CreateIndex
CREATE INDEX "transaction_snapshots_transaction_id_module_idx" ON "transaction_snapshots"("transaction_id", "module");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_statuses_transaction_id_status_key" ON "transaction_statuses"("transaction_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_trade_no_key" ON "transactions"("trade_no");

-- CreateIndex
CREATE INDEX "transactions_agent_idx" ON "transactions"("agent");

-- CreateIndex
CREATE INDEX "transactions_type_idx" ON "transactions"("type");

-- CreateIndex
CREATE INDEX "transactions_offer_date_idx" ON "transactions"("offer_date");

-- CreateIndex
CREATE INDEX "transactions_closing_date_idx" ON "transactions"("closing_date");

-- CreateIndex
CREATE INDEX "transactions_payment_type_idx" ON "transactions"("payment_type");

-- CreateIndex
CREATE INDEX "transactions_lead_source_idx" ON "transactions"("lead_source");

-- CreateIndex
CREATE INDEX "trashed_row_items_transaction_id_idx" ON "trashed_row_items"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_permissions_user_id_screen_key" ON "user_permissions"("user_id", "screen");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "brokerage_agents" ADD CONSTRAINT "brokerage_agents_brokerage_id_fkey" FOREIGN KEY ("brokerage_id") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "brokerages" ADD CONSTRAINT "brokerages_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_identifications" ADD CONSTRAINT "client_identifications_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conditions" ADD CONSTRAINT "conditions_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_mail_account_id_fkey" FOREIGN KEY ("mail_account_id") REFERENCES "mail_accounts"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inter_board_listings" ADD CONSTRAINT "inter_board_listings_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "precon_terms" ADD CONSTRAINT "precon_terms_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "team_member_terms" ADD CONSTRAINT "team_member_terms_team_member_id_fkey" FOREIGN KEY ("team_member_id") REFERENCES "team_members"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transaction_delete_requests" ADD CONSTRAINT "transaction_delete_requests_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transaction_edit_requests" ADD CONSTRAINT "transaction_edit_requests_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transaction_message_reads" ADD CONSTRAINT "transaction_message_reads_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transaction_message_reads" ADD CONSTRAINT "transaction_message_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transaction_messages" ADD CONSTRAINT "transaction_messages_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transaction_snapshots" ADD CONSTRAINT "transaction_snapshots_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transaction_statuses" ADD CONSTRAINT "transaction_statuses_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trashed_row_items" ADD CONSTRAINT "trashed_row_items_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

