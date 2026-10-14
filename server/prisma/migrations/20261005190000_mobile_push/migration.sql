-- Additive native registration. Session deletion/revocation cascades registrations and receipts.
CREATE TABLE "mobile_push_devices" (
 "id" SERIAL PRIMARY KEY, "user_id" INTEGER NOT NULL,
 "session_sid" VARCHAR NOT NULL UNIQUE REFERENCES "user_sessions"("sid") ON DELETE CASCADE,
 "push_token" VARCHAR(160) NOT NULL UNIQUE, "platform" VARCHAR(16) NOT NULL,
 "expires_at" TIMESTAMP(6) NOT NULL
);
CREATE INDEX "mobile_push_devices_user_id_expires_at_idx" ON "mobile_push_devices"("user_id", "expires_at");
CREATE TABLE "mobile_push_receipts" (
 "ticket_id" VARCHAR(128) PRIMARY KEY,
 "device_id" INTEGER NOT NULL REFERENCES "mobile_push_devices"("id") ON DELETE CASCADE,
 "push_token" VARCHAR(160) NOT NULL, "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
 "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "mobile_push_receipts_status_created_at_idx" ON "mobile_push_receipts"("status", "created_at");
