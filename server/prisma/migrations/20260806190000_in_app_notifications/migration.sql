-- A store for IN-APP notifications.
--
-- WHY THIS EXISTS NOW, HAVING BEEN ARGUED AGAINST EARLIER. When the Notification Centre was built,
-- every notification in this application was DERIVED — an audit-log row, a review, a reminder — and
-- a table would have meant writing a second copy of events already recorded, kept in step forever.
-- That reasoning was right for those four sources and they are unchanged: the Centre still reads
-- them directly and nothing is duplicated.
--
-- What changed is the requirement. Two categories the dispatcher must deliver — team chat mentions
-- and new inbox mail — have NO derived source the Centre can read, and several others have no
-- in-app representation at all. There is nowhere to put those, so an in-app notification for them
-- cannot be delivered by reading something else. This is the somewhere.
--
-- It is therefore ADDITIVE, not a replacement: the Centre gains a fifth source and keeps the four
-- it had.

CREATE TABLE "notifications" (
    "id"         SERIAL       NOT NULL,
    "user_id"    INTEGER      NOT NULL,
    "category"   VARCHAR(64)  NOT NULL,
    "title"      VARCHAR(255) NOT NULL,
    "body"       TEXT,
    -- Where "open the related record" goes. Nullable: not every notification has a record.
    "link"       VARCHAR(255),
    -- Idempotency handle. A sweep that runs twice, or a job retried after a partial failure, must
    -- not leave somebody two copies of the same notification.
    "dedupe_key" VARCHAR(190),
    "read_at"    TIMESTAMP(0),
    "created_at" TIMESTAMP(0) NOT NULL,
    "company_id" INTEGER      NOT NULL DEFAULT 1,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- NULLs are distinct in Postgres, so notifications without a dedupe key are never blocked by this;
-- only two deliberate deliveries claiming the same key collide, which is the point.
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- The two reads: "my unread count" and "my feed, newest first".
CREATE INDEX "notifications_user_id_read_at_idx"    ON "notifications"("user_id", "read_at");
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");
CREATE INDEX "notifications_company_id_idx"         ON "notifications"("company_id");

-- Deleting an account takes its notifications with it.
ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
