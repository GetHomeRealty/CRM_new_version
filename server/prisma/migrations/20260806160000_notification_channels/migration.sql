-- Per-channel notification preferences.
--
-- Until now `notification_preferences` held ONE boolean per (user, category), and that boolean meant
-- PUSH — the settings screen says so in as many words: "Turning something off here stops the push
-- notification only. Emails and in-app notifications are unaffected." The table could not express
-- "email off, push on", which is what this migration adds.
--
-- WHY THE DEFAULT IS 'push' AND NOT ANYTHING ELSE. Every existing row was written by somebody
-- muting a PUSH notification. Defaulting the new column to 'push' therefore preserves the exact
-- meaning of each row that is already there: a person who muted calendar push stays muted for push
-- and — correctly — is not muted for email, which they never asked for. Any other default would
-- silently re-interpret their choice as something they never made.
--
-- Additive and reversible in effect: absence of a row still means "on", so nothing starts or stops
-- arriving because of this migration alone.

ALTER TABLE "notification_preferences"
    ADD COLUMN "channel" VARCHAR(16) NOT NULL DEFAULT 'push';

-- The uniqueness rule moves from (user, category) to (user, category, channel): one person may now
-- hold a different answer per channel for the same event, which is the whole point.
DROP INDEX IF EXISTS "notification_preferences_user_id_category_key";

CREATE UNIQUE INDEX "notification_preferences_user_id_category_channel_key"
    ON "notification_preferences"("user_id", "category", "channel");

-- Reads are "every preference for this person" (the settings screen) and "this person, this
-- category, this channel" (the send path). The second is the one on a hot path.
CREATE INDEX "notification_preferences_user_id_category_idx"
    ON "notification_preferences"("user_id", "category");
