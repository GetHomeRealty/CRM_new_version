-- Click tracking for campaigns.
--
-- Opens tell you the subject line worked. Clicks tell you which property somebody wants to see,
-- which is the thing an agent can act on — so this is the more useful half of the tracking story
-- and the half that was missing.
--
-- THE DESIGN POINT: links are stored server-side and redirected to BY ID. The obvious approach —
-- putting the destination in the query string — makes the endpoint an open redirect, which lets a
-- stranger send `…/track/click?u=https://evil.example` and have it arrive from the brokerage's own
-- domain, in a real campaign email, lending it the brokerage's reputation. Recording the URL at
-- send time and never accepting one from the request removes that entirely.

CREATE TABLE "campaign_links" (
    "id"          SERIAL NOT NULL,
    "campaign_id" INTEGER NOT NULL,
    -- Text, not VarChar: MLS and mapping URLs carry long query strings and truncating one would
    -- send a recipient somewhere subtly different from where the agent linked.
    "url"         TEXT NOT NULL,
    "clicks"      INTEGER NOT NULL DEFAULT 0,
    "created_at"  TIMESTAMP(3),
    "company_id"  INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "campaign_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "campaign_links_campaign_id_idx" ON "campaign_links"("campaign_id");
CREATE INDEX "campaign_links_company_id_idx" ON "campaign_links"("company_id");
ALTER TABLE "campaign_links"
    ADD CONSTRAINT "campaign_links_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Per-recipient click record. Separate from campaign_links so "how many people clicked" and
-- "which links were popular" are both answerable — one recipient clicking one link five times is
-- five clicks but one clicker, and conflating those overstates engagement.
CREATE TABLE "campaign_clicks" (
    "id"           SERIAL NOT NULL,
    "campaign_id"  INTEGER NOT NULL,
    "recipient_id" INTEGER NOT NULL,
    "link_id"      INTEGER NOT NULL,
    "clicked_at"   TIMESTAMP(3) NOT NULL,
    "company_id"   INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "campaign_clicks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "campaign_clicks_campaign_id_idx" ON "campaign_clicks"("campaign_id");
CREATE INDEX "campaign_clicks_recipient_id_idx" ON "campaign_clicks"("recipient_id");
CREATE INDEX "campaign_clicks_company_id_idx" ON "campaign_clicks"("company_id");
-- One row per recipient per link: a re-click updates rather than inserts, so `clickers` stays a
-- count of people rather than of impatience.
CREATE UNIQUE INDEX "campaign_clicks_recipient_link_key" ON "campaign_clicks"("recipient_id", "link_id");

ALTER TABLE "campaign_clicks"
    ADD CONSTRAINT "campaign_clicks_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "campaign_clicks"
    ADD CONSTRAINT "campaign_clicks_recipient_id_fkey"
    FOREIGN KEY ("recipient_id") REFERENCES "campaign_recipients"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "campaign_clicks"
    ADD CONSTRAINT "campaign_clicks_link_id_fkey"
    FOREIGN KEY ("link_id") REFERENCES "campaign_links"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Headline counters on the campaign, so the list screen needs no joins.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "clicked" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "clicked_at" TIMESTAMP(3);
