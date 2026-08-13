-- Remove multi-brokerage tenancy from the schema. DESTRUCTIVE — read the companion migration first.
--
-- PRECONDITION, AND IT IS NOT OPTIONAL: `20260808140000_tenant_removal_replacement_constraints`
-- must already be applied. That migration creates the seven constraints that carry the business
-- rules the tenant-scoped ones were enforcing. Three of them — the `crm_settings` shared-row
-- singleton, the `crm_email_settings` singleton and the `subscriptions` licence singleton — were
-- unique indexes on `company_id` ALONE, so the column drops below do not narrow them, they remove
-- them. Running this migration without the other one silently permits a second SMTP configuration
-- and a second licence row, and the application reads both with `findFirst`.
--
-- VERIFIED BEFORE THIS WAS WRITTEN, on the development database: every `company_id` in all 86
-- tables holds the value 1. Nothing distinguishes one row from another by this column, so dropping
-- it discards no information. The guard below re-checks that on whatever database it is applied to
-- and refuses rather than destroying a second brokerage's only means of being told apart.
--
-- WHAT IS DELIBERATELY KEPT:
--   company_settings   the brokerage's own record — name, address, HST number, banking details,
--                      invoice prefix and next invoice number, tax rate, terms, letterhead logo.
--                      It was drafted into being the tenant root; it is first and last a settings
--                      table and every invoice depends on it.
--   subscriptions      the module licence. It is what keeps CRM and Transaction Desk separately
--                      gated, and that separation is required to survive this work.
--   brokerages,        the CO-OPERATING brokerage on a transaction and its agents — the other side
--   brokerage_agents   of a deal. Real-estate counterparty data, never tenancy.
--
-- Indexes and foreign keys on `company_id` are dropped implicitly by PostgreSQL when the column
-- goes, so they are not enumerated: 21 foreign keys and 88 indexes disappear with the columns below.
--
-- ONE OF THE THREE SINGLETONS TURNED OUT NOT TO NEED REPLACING, and the redundancy is undone below
-- rather than left in place. `crm_settings` has carried `crm_settings_global_key` — a unique index
-- on the expression `(user_id IS NULL)`, partial on the same condition — since the table was
-- created in `20260722220000_crm_settings`, months before tenancy existed. It already says "at most
-- one shared row" without reference to any company, so dropping `company_id` never threatened that
-- rule. The companion migration added `crm_settings_single_global_key` anyway, on the belief that
-- `crm_settings_global_per_company_key` was the only guard; two identical unique indexes on one
-- table cost writes and mislead the next reader, so the new one goes.
--
-- The other two replacements are NOT redundant and must stay: `crm_email_settings` and
-- `subscriptions` had no such pre-existing guard, and their only uniqueness was on `company_id`.

DROP INDEX IF EXISTS "crm_settings_single_global_key";

-- Written as an explicit loop with EXECUTE rather than as one set-returning query. The first
-- attempt inlined the per-table probe into a subquery over `information_schema.columns`, and the
-- planner was free to evaluate that probe BEFORE the `column_name = 'company_id'` filter that made
-- it meaningful — so it built `SELECT count(*) FROM _prisma_migrations WHERE company_id ...` and
-- died on a table that has no such column. A loop cannot be reordered.
DO $$
DECLARE
  r        record;
  bad      bigint;
  offenders text := '';
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'company_id'
     ORDER BY table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE company_id IS DISTINCT FROM 1', r.table_name) INTO bad;
    IF bad > 0 THEN
      offenders := offenders || format('%s (%s rows), ', r.table_name, bad);
    END IF;
  END LOOP;

  IF offenders <> '' THEN
    RAISE EXCEPTION
      'Refusing to drop company_id: these tables hold rows for a company other than 1 — %. This database serves more than one brokerage, and dropping the column would merge them irreversibly.', offenders;
  END IF;
END $$;

ALTER TABLE "agents" DROP COLUMN "company_id";
ALTER TABLE "audit_logs" DROP COLUMN "company_id";
ALTER TABLE "brokerage_agents" DROP COLUMN "company_id";
ALTER TABLE "brokerages" DROP COLUMN "company_id";
ALTER TABLE "calendar_event_reminders" DROP COLUMN "company_id";
ALTER TABLE "calendar_events" DROP COLUMN "company_id";
ALTER TABLE "campaign_clicks" DROP COLUMN "company_id";
ALTER TABLE "campaign_links" DROP COLUMN "company_id";
ALTER TABLE "campaign_recipients" DROP COLUMN "company_id";
ALTER TABLE "campaign_template_attachments" DROP COLUMN "company_id";
ALTER TABLE "campaign_templates" DROP COLUMN "company_id";
ALTER TABLE "campaigns" DROP COLUMN "company_id";
ALTER TABLE "client_identifications" DROP COLUMN "company_id";
ALTER TABLE "clients" DROP COLUMN "company_id";
ALTER TABLE "conditions" DROP COLUMN "company_id";
ALTER TABLE "crm_broadcasts" DROP COLUMN "company_id";
ALTER TABLE "crm_email_log" DROP COLUMN "company_id";
ALTER TABLE "crm_email_settings" DROP COLUMN "company_id";
ALTER TABLE "crm_referral_codes" DROP COLUMN "company_id";
ALTER TABLE "crm_settings" DROP COLUMN "company_id";
ALTER TABLE "crm_trigger_settings" DROP COLUMN "company_id";
ALTER TABLE "customers" DROP COLUMN "company_id";
ALTER TABLE "document_reminders" DROP COLUMN "company_id";
ALTER TABLE "documents" DROP COLUMN "company_id";
ALTER TABLE "email_suppressions" DROP COLUMN "company_id";
ALTER TABLE "email_template_attachments" DROP COLUMN "company_id";
ALTER TABLE "email_templates" DROP COLUMN "company_id";
ALTER TABLE "export_jobs" DROP COLUMN "company_id";
ALTER TABLE "favorites" DROP COLUMN "company_id";
ALTER TABLE "google_connections" DROP COLUMN "company_id";
ALTER TABLE "ical_feeds" DROP COLUMN "company_id";
ALTER TABLE "import_batches" DROP COLUMN "company_id";
ALTER TABLE "inbound_emails" DROP COLUMN "company_id";
ALTER TABLE "inter_board_listings" DROP COLUMN "company_id";
ALTER TABLE "invoice_line_items" DROP COLUMN "company_id";
ALTER TABLE "invoice_payments" DROP COLUMN "company_id";
ALTER TABLE "invoices" DROP COLUMN "company_id";
ALTER TABLE "lead_call_recordings" DROP COLUMN "company_id";
ALTER TABLE "lead_calls" DROP COLUMN "company_id";
ALTER TABLE "lead_emails" DROP COLUMN "company_id";
ALTER TABLE "lead_import_jobs" DROP COLUMN "company_id";
ALTER TABLE "lead_messages" DROP COLUMN "company_id";
ALTER TABLE "lead_notes" DROP COLUMN "company_id";
ALTER TABLE "lead_showings" DROP COLUMN "company_id";
ALTER TABLE "lead_tags" DROP COLUMN "company_id";
ALTER TABLE "lead_tasks" DROP COLUMN "company_id";
ALTER TABLE "leads" DROP COLUMN "company_id";
ALTER TABLE "mail_accounts" DROP COLUMN "company_id";
ALTER TABLE "marketing_inventory" DROP COLUMN "company_id";
ALTER TABLE "meta_connections" DROP COLUMN "company_id";
ALTER TABLE "meta_lead_forms" DROP COLUMN "company_id";
ALTER TABLE "meta_pages" DROP COLUMN "company_id";
ALTER TABLE "meta_sync_history" DROP COLUMN "company_id";
ALTER TABLE "meta_webhook_events" DROP COLUMN "company_id";
ALTER TABLE "mfa_challenges" DROP COLUMN "company_id";
ALTER TABLE "mfa_policies" DROP COLUMN "company_id";
ALTER TABLE "mfa_recovery_codes" DROP COLUMN "company_id";
ALTER TABLE "mfa_trusted_devices" DROP COLUMN "company_id";
ALTER TABLE "notification_preferences" DROP COLUMN "company_id";
ALTER TABLE "notifications" DROP COLUMN "company_id";
ALTER TABLE "personal_access_tokens" DROP COLUMN "company_id";
ALTER TABLE "precon_terms" DROP COLUMN "company_id";
ALTER TABLE "push_subscriptions" DROP COLUMN "company_id";
ALTER TABLE "role_permissions" DROP COLUMN "company_id";
ALTER TABLE "roles" DROP COLUMN "company_id";
ALTER TABLE "sessions" DROP COLUMN "company_id";
ALTER TABLE "subscriptions" DROP COLUMN "company_id";
ALTER TABLE "team_member_terms" DROP COLUMN "company_id";
ALTER TABLE "team_members" DROP COLUMN "company_id";
ALTER TABLE "todos" DROP COLUMN "company_id";
ALTER TABLE "transaction_delete_requests" DROP COLUMN "company_id";
ALTER TABLE "transaction_edit_requests" DROP COLUMN "company_id";
ALTER TABLE "transaction_message_reads" DROP COLUMN "company_id";
ALTER TABLE "transaction_messages" DROP COLUMN "company_id";
ALTER TABLE "transaction_reminders" DROP COLUMN "company_id";
ALTER TABLE "transaction_review_attachments" DROP COLUMN "company_id";
ALTER TABLE "transaction_review_messages" DROP COLUMN "company_id";
ALTER TABLE "transaction_reviews" DROP COLUMN "company_id";
ALTER TABLE "transaction_snapshots" DROP COLUMN "company_id";
ALTER TABLE "transaction_statuses" DROP COLUMN "company_id";
ALTER TABLE "transactions" DROP COLUMN "company_id";
ALTER TABLE "trashed_row_items" DROP COLUMN "company_id";
ALTER TABLE "user_mfa_methods" DROP COLUMN "company_id";
ALTER TABLE "user_modules" DROP COLUMN "company_id";
ALTER TABLE "user_permissions" DROP COLUMN "company_id";
ALTER TABLE "users" DROP COLUMN "company_id";
