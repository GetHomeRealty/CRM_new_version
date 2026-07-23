-- Twilio delivery tracking on an outbound SMS.
--
-- Purely additive and all nullable, so every existing row stays valid: messages logged before a
-- gateway was connected simply carry no provider SID. The unique index on provider_sid is what
-- lets a status callback find the message it refers to, and stops a replayed callback creating
-- a second row.

ALTER TABLE "lead_messages" ADD COLUMN IF NOT EXISTS "provider_sid"  VARCHAR(64);
ALTER TABLE "lead_messages" ADD COLUMN IF NOT EXISTS "error_code"    VARCHAR(16);
ALTER TABLE "lead_messages" ADD COLUMN IF NOT EXISTS "error_message" VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS "lead_messages_provider_sid_key" ON "lead_messages"("provider_sid");
