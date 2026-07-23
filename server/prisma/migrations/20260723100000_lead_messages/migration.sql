-- SMS conversation history on a lead.
--
-- Purely additive: one new table. Nothing existing is altered, and the transaction / document /
-- invoice / commission core is untouched.
--
-- Note there are deliberately no delivery-status or provider-id columns. The app has no SMS
-- gateway; the browser hands the text to the device's messaging app through an `sms:` link and
-- this table records what was sent or received. Adding status columns would imply a delivery
-- guarantee the app cannot make.

CREATE TABLE IF NOT EXISTS "lead_messages" (
  "id"         SERIAL PRIMARY KEY,
  "lead_id"    INTEGER      NOT NULL,
  "direction"  VARCHAR(16)  NOT NULL,
  "body"       TEXT         NOT NULL,
  "phone"      VARCHAR(64),
  "sent_at"    TIMESTAMP(0) NOT NULL,
  "created_by" VARCHAR(255),
  "user_id"    INTEGER,
  "created_at" TIMESTAMP(0),
  CONSTRAINT "lead_messages_lead_id_fkey" FOREIGN KEY ("lead_id")
    REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX IF NOT EXISTS "lead_messages_lead_id_idx" ON "lead_messages"("lead_id");
