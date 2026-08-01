-- Where an agent's browser can be reached with a push notification.
--
-- One row per BROWSER, not per person: an agent with a phone and a desktop has two, and a reminder
-- goes to both. A subscription is issued by the push service (Google's, Mozilla's) and is opaque to
-- us -- the endpoint is a URL we POST to, and the two keys encrypt the payload so the push service
-- itself cannot read the appointment.
--
-- These are not credentials of ours but they are personal data: an endpoint identifies a specific
-- browser on a specific device. They are deleted the moment the push service says the subscription
-- is gone (HTTP 404/410), which is what happens when somebody clears their browser data.
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
    "id"          SERIAL       PRIMARY KEY,
    "user_id"     INTEGER      NOT NULL,
    -- The push service URL. Long: Chrome's run past 200 characters.
    "endpoint"    TEXT         NOT NULL,
    -- The browser's public key and auth secret, used to encrypt each payload (RFC 8291).
    "p256dh"      VARCHAR(255) NOT NULL,
    "auth"        VARCHAR(255) NOT NULL,
    -- Which area's reminders this browser asked for, so the CRM and the Desk stay separate here too.
    "scope"       VARCHAR(8),
    "user_agent"  VARCHAR(255),
    "last_used_at" TIMESTAMP(3),
    -- Consecutive delivery failures. A subscription that keeps failing is dropped rather than
    -- retried for ever against a browser that is never coming back.
    "failures"    INTEGER      NOT NULL DEFAULT 0,
    "company_id"  INTEGER      NOT NULL DEFAULT 1,
    "created_at"  TIMESTAMP(3),
    "updated_at"  TIMESTAMP(3)
);

-- The endpoint IS the identity of a browser. Re-subscribing on the same device returns the same
-- endpoint, so this turns "subscribe again" into an update instead of a duplicate that would make
-- every reminder arrive twice.
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_key" ON "push_subscriptions" ("endpoint");
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_idx" ON "push_subscriptions" ("user_id");
CREATE INDEX IF NOT EXISTS "push_subscriptions_company_idx" ON "push_subscriptions" ("company_id");

DO $$
BEGIN
    ALTER TABLE "push_subscriptions"
        ADD CONSTRAINT "push_subscriptions_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Which reminders were pushed, alongside which were emailed. Same row, so "was I told about this?"
-- has one answer rather than two half-answers.
ALTER TABLE "calendar_event_reminders" ADD COLUMN IF NOT EXISTS "pushed_at" TIMESTAMP(3);
ALTER TABLE "calendar_event_reminders" ADD COLUMN IF NOT EXISTS "push_count" INTEGER NOT NULL DEFAULT 0;
