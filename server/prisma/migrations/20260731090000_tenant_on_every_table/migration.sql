-- Give every business table its own company_id.
--
-- Isolation was inherited through a parent relation, which holds only while a query goes
-- through the parent. It does not: `lead_notes.findMany({ where: { lead_id } })` reads a
-- child table directly, nothing filters it, and another brokerage's note comes back. That was
-- reproduced against this database before writing this migration.
--
-- So the tenant is denormalised onto every child. The column is redundant with the parent by
-- construction, which is the one risk it carries — a child could drift from its parent. That is
-- covered by a test that walks every relation and asserts the two agree, so drift is a failing
-- build rather than a silent leak.
--
-- Backfilled from the parent row, ordered so a parent is always filled before its children.
-- Additive and reversible: no row moves, no id changes, and the column defaults to 1 so any
-- INSERT written before this migration still lands somewhere valid.

-- ---------- depth 1 ----------
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "audit_logs" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "audit_logs_company_id_idx" ON "audit_logs"("company_id");

ALTER TABLE "brokerages" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "brokerages" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "brokerages_company_id_idx" ON "brokerages"("company_id");

ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "calendar_events" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "calendar_events_company_id_idx" ON "calendar_events"("company_id");

ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "campaign_recipients" c SET "company_id" = COALESCE(p."company_id", 1) FROM "campaigns" p WHERE p."id" = c."campaign_id";
CREATE INDEX IF NOT EXISTS "campaign_recipients_company_id_idx" ON "campaign_recipients"("company_id");

ALTER TABLE "campaign_templates" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "campaign_templates" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "campaign_templates_company_id_idx" ON "campaign_templates"("company_id");

ALTER TABLE "client_identifications" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "client_identifications" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "client_identifications_company_id_idx" ON "client_identifications"("company_id");

ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "clients" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "clients_company_id_idx" ON "clients"("company_id");

ALTER TABLE "conditions" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "conditions" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "conditions_company_id_idx" ON "conditions"("company_id");

ALTER TABLE "crm_settings" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "crm_settings" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "crm_settings_company_id_idx" ON "crm_settings"("company_id");

ALTER TABLE "document_reminders" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "document_reminders" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "document_reminders_company_id_idx" ON "document_reminders"("company_id");

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "documents" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "documents_company_id_idx" ON "documents"("company_id");

ALTER TABLE "favorites" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "favorites" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "favorites_company_id_idx" ON "favorites"("company_id");

ALTER TABLE "google_connections" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "google_connections" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "google_connections_company_id_idx" ON "google_connections"("company_id");

ALTER TABLE "ical_feeds" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "ical_feeds" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "ical_feeds_company_id_idx" ON "ical_feeds"("company_id");

ALTER TABLE "inter_board_listings" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "inter_board_listings" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "inter_board_listings_company_id_idx" ON "inter_board_listings"("company_id");

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "invoices" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "invoices_company_id_idx" ON "invoices"("company_id");

ALTER TABLE "lead_calls" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "lead_calls" c SET "company_id" = COALESCE(p."company_id", 1) FROM "leads" p WHERE p."id" = c."lead_id";
CREATE INDEX IF NOT EXISTS "lead_calls_company_id_idx" ON "lead_calls"("company_id");

ALTER TABLE "lead_emails" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "lead_emails" c SET "company_id" = COALESCE(p."company_id", 1) FROM "leads" p WHERE p."id" = c."lead_id";
CREATE INDEX IF NOT EXISTS "lead_emails_company_id_idx" ON "lead_emails"("company_id");

ALTER TABLE "lead_messages" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "lead_messages" c SET "company_id" = COALESCE(p."company_id", 1) FROM "leads" p WHERE p."id" = c."lead_id";
CREATE INDEX IF NOT EXISTS "lead_messages_company_id_idx" ON "lead_messages"("company_id");

ALTER TABLE "lead_notes" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "lead_notes" c SET "company_id" = COALESCE(p."company_id", 1) FROM "leads" p WHERE p."id" = c."lead_id";
CREATE INDEX IF NOT EXISTS "lead_notes_company_id_idx" ON "lead_notes"("company_id");

ALTER TABLE "lead_showings" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "lead_showings" c SET "company_id" = COALESCE(p."company_id", 1) FROM "leads" p WHERE p."id" = c."lead_id";
CREATE INDEX IF NOT EXISTS "lead_showings_company_id_idx" ON "lead_showings"("company_id");

ALTER TABLE "lead_tasks" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "lead_tasks" c SET "company_id" = COALESCE(p."company_id", 1) FROM "leads" p WHERE p."id" = c."lead_id";
CREATE INDEX IF NOT EXISTS "lead_tasks_company_id_idx" ON "lead_tasks"("company_id");

ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "mail_accounts" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "mail_accounts_company_id_idx" ON "mail_accounts"("company_id");

ALTER TABLE "meta_connections" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "meta_connections" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "meta_connections_company_id_idx" ON "meta_connections"("company_id");

ALTER TABLE "meta_lead_forms" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "meta_lead_forms" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "meta_lead_forms_company_id_idx" ON "meta_lead_forms"("company_id");

ALTER TABLE "meta_sync_history" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "meta_sync_history" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "meta_sync_history_company_id_idx" ON "meta_sync_history"("company_id");

ALTER TABLE "precon_terms" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "precon_terms" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "precon_terms_company_id_idx" ON "precon_terms"("company_id");

ALTER TABLE "role_permissions" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "role_permissions" c SET "company_id" = COALESCE(p."company_id", 1) FROM "roles" p WHERE p."id" = c."role_id";
CREATE INDEX IF NOT EXISTS "role_permissions_company_id_idx" ON "role_permissions"("company_id");

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "sessions" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "sessions_company_id_idx" ON "sessions"("company_id");

ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "team_members" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "team_members_company_id_idx" ON "team_members"("company_id");

ALTER TABLE "todos" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "todos" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";  -- link inferred from column name; no FK declared
CREATE INDEX IF NOT EXISTS "todos_company_id_idx" ON "todos"("company_id");

ALTER TABLE "transaction_delete_requests" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "transaction_delete_requests" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "transaction_delete_requests_company_id_idx" ON "transaction_delete_requests"("company_id");

ALTER TABLE "transaction_edit_requests" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "transaction_edit_requests" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "transaction_edit_requests_company_id_idx" ON "transaction_edit_requests"("company_id");

ALTER TABLE "transaction_message_reads" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "transaction_message_reads" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "transaction_message_reads_company_id_idx" ON "transaction_message_reads"("company_id");

ALTER TABLE "transaction_messages" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "transaction_messages" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "transaction_messages_company_id_idx" ON "transaction_messages"("company_id");

ALTER TABLE "transaction_snapshots" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "transaction_snapshots" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "transaction_snapshots_company_id_idx" ON "transaction_snapshots"("company_id");

ALTER TABLE "transaction_statuses" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "transaction_statuses" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "transaction_statuses_company_id_idx" ON "transaction_statuses"("company_id");

ALTER TABLE "trashed_row_items" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "trashed_row_items" c SET "company_id" = COALESCE(p."company_id", 1) FROM "transactions" p WHERE p."id" = c."transaction_id";
CREATE INDEX IF NOT EXISTS "trashed_row_items_company_id_idx" ON "trashed_row_items"("company_id");

ALTER TABLE "user_modules" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "user_modules" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";
CREATE INDEX IF NOT EXISTS "user_modules_company_id_idx" ON "user_modules"("company_id");

ALTER TABLE "user_permissions" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "user_permissions" c SET "company_id" = COALESCE(p."company_id", 1) FROM "users" p WHERE p."id" = c."user_id";
CREATE INDEX IF NOT EXISTS "user_permissions_company_id_idx" ON "user_permissions"("company_id");

-- ---------- depth 2 ----------
ALTER TABLE "brokerage_agents" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "brokerage_agents" c SET "company_id" = COALESCE(p."company_id", 1) FROM "brokerages" p WHERE p."id" = c."brokerage_id";
CREATE INDEX IF NOT EXISTS "brokerage_agents_company_id_idx" ON "brokerage_agents"("company_id");

ALTER TABLE "campaign_template_attachments" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "campaign_template_attachments" c SET "company_id" = COALESCE(p."company_id", 1) FROM "campaign_templates" p WHERE p."id" = c."template_id";
CREATE INDEX IF NOT EXISTS "campaign_template_attachments_company_id_idx" ON "campaign_template_attachments"("company_id");

ALTER TABLE "email_templates" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "email_templates" c SET "company_id" = COALESCE(p."company_id", 1) FROM "mail_accounts" p WHERE p."id" = c."mail_account_id";
CREATE INDEX IF NOT EXISTS "email_templates_company_id_idx" ON "email_templates"("company_id");

ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "inbound_emails" c SET "company_id" = COALESCE(p."company_id", 1) FROM "mail_accounts" p WHERE p."id" = c."account_id";
CREATE INDEX IF NOT EXISTS "inbound_emails_company_id_idx" ON "inbound_emails"("company_id");

ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "invoice_line_items" c SET "company_id" = COALESCE(p."company_id", 1) FROM "invoices" p WHERE p."id" = c."invoice_id";
CREATE INDEX IF NOT EXISTS "invoice_line_items_company_id_idx" ON "invoice_line_items"("company_id");

ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "invoice_payments" c SET "company_id" = COALESCE(p."company_id", 1) FROM "invoices" p WHERE p."id" = c."invoice_id";
CREATE INDEX IF NOT EXISTS "invoice_payments_company_id_idx" ON "invoice_payments"("company_id");

ALTER TABLE "lead_call_recordings" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "lead_call_recordings" c SET "company_id" = COALESCE(p."company_id", 1) FROM "lead_calls" p WHERE p."id" = c."call_id";
CREATE INDEX IF NOT EXISTS "lead_call_recordings_company_id_idx" ON "lead_call_recordings"("company_id");

ALTER TABLE "meta_pages" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "meta_pages" c SET "company_id" = COALESCE(p."company_id", 1) FROM "meta_connections" p WHERE p."id" = c."connection_id";
CREATE INDEX IF NOT EXISTS "meta_pages_company_id_idx" ON "meta_pages"("company_id");

ALTER TABLE "team_member_terms" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "team_member_terms" c SET "company_id" = COALESCE(p."company_id", 1) FROM "team_members" p WHERE p."id" = c."team_member_id";
CREATE INDEX IF NOT EXISTS "team_member_terms_company_id_idx" ON "team_member_terms"("company_id");

-- ---------- depth 3 ----------
ALTER TABLE "email_template_attachments" ADD COLUMN IF NOT EXISTS "company_id" INTEGER NOT NULL DEFAULT 1;
UPDATE "email_template_attachments" c SET "company_id" = COALESCE(p."company_id", 1) FROM "email_templates" p WHERE p."id" = c."template_id";
CREATE INDEX IF NOT EXISTS "email_template_attachments_company_id_idx" ON "email_template_attachments"("company_id");

