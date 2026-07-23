-- Campaigns: marketing leads, campaigns, per-recipient tracking and the opt-out list.
-- Ported from the Next.js/MongoDB campaign engine onto Postgres.

CREATE TABLE "leads" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(64),
    "lead_status" VARCHAR(32),
    "lead_type" VARCHAR(48),
    "lead_source" VARCHAR(48),
    "client_type" VARCHAR(48),
    "tags" TEXT,
    "location" VARCHAR(255),
    "property_address" VARCHAR(255),
    "property_price" VARCHAR(64),
    "bedrooms" VARCHAR(16),
    "bathrooms" VARCHAR(16),
    "square_footage" VARCHAR(24),
    "key_features" TEXT,
    "unsubscribed" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribed_at" TIMESTAMP(0),
    "owner_user_id" INTEGER,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    "deleted_at" TIMESTAMP(0),
    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "leads_email_idx" ON "leads"("email");
CREATE INDEX "leads_lead_status_idx" ON "leads"("lead_status");
CREATE INDEX "leads_lead_source_idx" ON "leads"("lead_source");
CREATE INDEX "leads_unsubscribed_idx" ON "leads"("unsubscribed");
-- One lead per address, compared case-insensitively (imports dedupe against this).
CREATE UNIQUE INDEX "leads_email_lower_key" ON "leads"(LOWER("email"));

CREATE TABLE "campaigns" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "template_id" INTEGER,
    "template_name" VARCHAR(255),
    "category" VARCHAR(64),
    "subject" VARCHAR(500) NOT NULL,
    "content" TEXT NOT NULL,
    "audience" TEXT,
    "tags" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "total" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "opened" INTEGER NOT NULL DEFAULT 0,
    "unsubscribed" INTEGER NOT NULL DEFAULT 0,
    "bounced" INTEGER NOT NULL DEFAULT 0,
    "created_by" VARCHAR(255),
    "created_by_id" INTEGER,
    "sent_at" TIMESTAMP(0),
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");
CREATE INDEX "campaigns_created_at_idx" ON "campaigns"("created_at");

CREATE TABLE "campaign_recipients" (
    "id" SERIAL NOT NULL,
    "campaign_id" INTEGER NOT NULL,
    "lead_id" INTEGER,
    "name" VARCHAR(255),
    "email" VARCHAR(255) NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "opened" BOOLEAN NOT NULL DEFAULT false,
    "opened_at" TIMESTAMP(0),
    "unsubscribed" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribed_at" TIMESTAMP(0),
    "bounced" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "campaign_recipients_token_key" ON "campaign_recipients"("token");
CREATE INDEX "campaign_recipients_campaign_id_idx" ON "campaign_recipients"("campaign_id");
CREATE INDEX "campaign_recipients_lead_id_idx" ON "campaign_recipients"("lead_id");
CREATE INDEX "campaign_recipients_email_idx" ON "campaign_recipients"("email");

-- Deleting a campaign removes its recipient rows; deleting a lead only unlinks them, so
-- the historical record of who was emailed survives.
ALTER TABLE "campaign_recipients"
    ADD CONSTRAINT "campaign_recipients_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "campaign_recipients"
    ADD CONSTRAINT "campaign_recipients_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

CREATE TABLE "email_suppressions" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "reason" VARCHAR(64),
    "campaign_id" INTEGER,
    "created_at" TIMESTAMP(0),
    "updated_at" TIMESTAMP(0),
    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_suppressions_email_key" ON "email_suppressions"("email");
