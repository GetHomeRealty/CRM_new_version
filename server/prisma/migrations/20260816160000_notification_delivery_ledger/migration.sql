-- The channel-independent notification delivery ledger.
--
-- ================================================================================================
-- WHAT THIS REPLACES. Deduplication used to be a side effect of the unique index on
-- notifications(user_id, dedupe_key), so the IN-APP row was what decided whether a notification had
-- already happened. That made dedupe a function of a channel preference: a recipient who muted
-- in-app and kept email wrote no row, so nothing recorded the send and every later pass re-sent.
-- And because only the in-app sender consulted the key, email and push were never deduped at all.
--
-- The ledger records one row per (recipient, category, occurrence, channel) for EVERY channel —
-- including muted ones — and independently of whether delivery succeeded.
-- ================================================================================================

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id         SERIAL       PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  category   VARCHAR(64)  NOT NULL,
  dedupe_key VARCHAR(190) NOT NULL,
  channel    VARCHAR(16)  NOT NULL,
  status     VARCHAR(16)  NOT NULL,
  detail     TEXT,
  created_at TIMESTAMP(0) NOT NULL,
  updated_at TIMESTAMP(0) NOT NULL
);

-- The claim itself. The dispatcher inserts with ON CONFLICT DO NOTHING before sending, so this is
-- what makes a race between two processes resolve to exactly one send rather than two.
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_identity_key
  ON notification_deliveries (user_id, category, dedupe_key, channel);

-- For pruning by age. The identity index above already serves the schedulers' lookup, which is an
-- equality match on the first three of its columns.
CREATE INDEX IF NOT EXISTS notification_deliveries_created_idx
  ON notification_deliveries (created_at);

-- ================================================================================================
-- BACKFILL, AND WHY IT IS NOT OPTIONAL.
--
-- On the first run after this deploys the ledger is empty. Every occurrence already notified before
-- today would therefore look unhandled, and every scheduler that reads the ledger would send it
-- again — one duplicate per overdue follow-up, per recipient, on the first pass. That is precisely
-- the failure this whole change exists to prevent, arriving as a one-off wave.
--
-- An existing notifications row with a dedupe_key is proof that `dispatch` RAN for that occurrence,
-- and dispatch attempts every enabled channel in a single call. So the occurrence was handled on all
-- three channels, whatever each one individually did — which is exactly what the ledger needs to
-- know. The per-channel outcome at the time was never recorded anywhere and cannot be recovered, so
-- it is written as `assumed` rather than as `sent`: the ledger says "this was dealt with", and does
-- not claim more than that.
-- ================================================================================================

INSERT INTO notification_deliveries (user_id, category, dedupe_key, channel, status, created_at, updated_at)
SELECT n.user_id, n.category, n.dedupe_key, c.channel, 'assumed', n.created_at, n.created_at
  FROM notifications n
 CROSS JOIN (VALUES ('in_app'), ('email'), ('push')) AS c(channel)
 WHERE n.dedupe_key IS NOT NULL
   AND n.dedupe_key <> ''
ON CONFLICT (user_id, category, dedupe_key, channel) DO NOTHING;
