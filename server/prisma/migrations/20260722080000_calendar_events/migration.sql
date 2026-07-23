-- Calendar events: appointments, showings, viewings, open houses, follow-ups and calls.
-- Ported from the Next.js/MongoDB `events` collection; `leadId` becomes a nullable FK to a
-- transaction, since this application has transactions rather than leads.
CREATE TABLE "calendar_events" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "date" DATE NOT NULL,
    "time" VARCHAR(8) NOT NULL,
    "type" VARCHAR(24) NOT NULL DEFAULT 'meeting',
    "status" VARCHAR(16) NOT NULL DEFAULT 'scheduled',
    "location" VARCHAR(255),
    "description" TEXT,
    "attendees" VARCHAR(255),
    "contact_phone" VARCHAR(64),
    "contact_email" VARCHAR(255),
    "property_details" TEXT,
    "notes" TEXT,
    "enable_reminder" BOOLEAN NOT NULL DEFAULT false,
    "reminder_sent" BOOLEAN NOT NULL DEFAULT false,
    "transaction_id" INTEGER,
    "user_id" INTEGER,
    "created_by" VARCHAR(255),
    "google_calendar_id" VARCHAR(255),
    "last_synced_to_google" TIMESTAMP(0),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    "deleted_at" TIMESTAMP(0),
    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "calendar_events_date_idx" ON "calendar_events"("date");
CREATE INDEX "calendar_events_user_id_idx" ON "calendar_events"("user_id");
CREATE INDEX "calendar_events_transaction_id_idx" ON "calendar_events"("transaction_id");
CREATE INDEX "calendar_events_status_idx" ON "calendar_events"("status");

-- Deleting a transaction must not delete the appointments that referenced it.
ALTER TABLE "calendar_events"
    ADD CONSTRAINT "calendar_events_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
