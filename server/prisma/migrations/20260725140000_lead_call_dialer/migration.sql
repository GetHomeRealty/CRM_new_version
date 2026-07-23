-- Click-to-call via Twilio: track the Twilio Call SID + live status on a logged call. Additive.

ALTER TABLE "lead_calls" ADD COLUMN IF NOT EXISTS "provider_sid" VARCHAR(64);
ALTER TABLE "lead_calls" ADD COLUMN IF NOT EXISTS "status" VARCHAR(24);

CREATE INDEX IF NOT EXISTS "lead_calls_provider_sid_idx" ON "lead_calls"("provider_sid");
