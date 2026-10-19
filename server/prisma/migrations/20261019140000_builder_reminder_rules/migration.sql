-- Builder agreement and RERA reminders follow the company-document rules (Sai, 19 Oct 2026): a file
-- uploaded after an expiry's first reminder counts as the renewal, so that first reminder is kept.
ALTER TABLE "builder_agreements" ADD COLUMN "reminder_started_at" TIMESTAMP(0);
ALTER TABLE "builder_projects" ADD COLUMN "rera_reminder_started_at" TIMESTAMP(0);
