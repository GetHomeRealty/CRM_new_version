-- The Transaction Desk Inbox, completed: folders, threading, attachments, drafts and sent mail.
--
-- The inbox was READ-ONLY. `inbound_emails` held what the IMAP poller pulled from INBOX and nothing
-- else: no way to reply, no record of anything sent, no attachments, no archive, no trash, and no
-- thread — a reply typed elsewhere started a new conversation because nothing here knew what the
-- original message was.
--
-- MAIL SEPARATION IS UNCHANGED AND IS NOT WEAKENED BY ANY OF THIS. Every table below carries both a
-- `user_id` and an `account_id`, and `mail_accounts.scope` is what makes an account CRM or Desk. So a
-- Transaction Desk mailbox operation is scoped to (this user, an account this area owns) exactly as
-- the read side already is — the same address connected to both areas is still two mailboxes, and a
-- draft written in one cannot appear in the other.

-- ---------------------------------------------------------------------------
-- 1. Received mail gains a folder, a thread and an attachment flag.
--
-- `archived_at` and `deleted_at` are nullable timestamps rather than a status column, because both
-- questions the interface asks are "when", not "which": the Inbox shows rows with neither set,
-- Archive shows rows with the first, Trash the second. A message can be archived and then deleted;
-- it cannot be un-received.
ALTER TABLE inbound_emails
  ADD COLUMN IF NOT EXISTS archived_at      TIMESTAMP(0) NULL,
  ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMP(0) NULL,
  -- RFC 5322 threading. `in_reply_to` is the parent's Message-ID; `references_header` is the chain.
  ADD COLUMN IF NOT EXISTS in_reply_to      VARCHAR(512) NULL,
  ADD COLUMN IF NOT EXISTS references_header TEXT NULL,
  /*
   * The conversation this message belongs to.
   *
   * Derived on receipt: the FIRST id in `References`, else `In-Reply-To`, else the message's own
   * Message-ID. Every message in a well-behaved thread therefore resolves to the same key without a
   * recursive lookup, and a message that starts a conversation is its own thread. Stored rather than
   * computed so the list can group and the reply path can look up by one indexed column.
   */
  ADD COLUMN IF NOT EXISTS thread_key       VARCHAR(512) NULL,
  ADD COLUMN IF NOT EXISTS has_attachments  BOOLEAN NOT NULL DEFAULT false;

/*
 * The inbox list's own index.
 *
 * Every list query is "this user, this account, not archived, not deleted, newest first" — five
 * columns in exactly this order. Without it the poller's growing table is scanned and sorted on
 * every page of every mailbox.
 */
CREATE INDEX IF NOT EXISTS inbound_emails_mailbox_idx
  ON inbound_emails (user_id, account_id, archived_at, deleted_at, received_at DESC);

/* Opening a conversation is a lookup by thread within one mailbox. */
CREATE INDEX IF NOT EXISTS inbound_emails_thread_idx
  ON inbound_emails (user_id, thread_key);

-- ---------------------------------------------------------------------------
-- 2. Attachments on received mail.
--
-- THE FILE ITSELF IS NOT IN THE DATABASE. `storage_path` points into STORAGE_ROOT, the same place
-- transaction documents live. A ten-megabyte attachment in a `bytea` column is read into Node in
-- full every time the row is touched — including by a list query that only wanted the filename —
-- and it bloats every backup of the mail table. The metadata is what the list needs; the bytes are
-- streamed only when somebody asks for them.
CREATE TABLE IF NOT EXISTS inbound_email_attachments (
  id            SERIAL PRIMARY KEY,
  email_id      INTEGER NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  filename      VARCHAR(255) NOT NULL,
  mime          VARCHAR(255) NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  -- Set for inline images referenced by the HTML body (cid:...), so they are not offered as downloads.
  content_id    VARCHAR(255) NULL,
  storage_path  VARCHAR(512) NOT NULL,
  created_at    TIMESTAMP(0) NULL
);
CREATE INDEX IF NOT EXISTS inbound_email_attachments_email_idx ON inbound_email_attachments (email_id);

-- ---------------------------------------------------------------------------
-- 3. Drafts and sent mail.
--
-- ONE TABLE FOR BOTH, distinguished by `status`, because a draft becomes a sent message in place:
-- the same recipients, subject, body, attachments and thread. Two tables would mean copying all of
-- that across at the moment of sending — the one moment where losing it matters most.
--
-- `status` is 'draft' | 'sent' | 'failed'. A FAILED SEND IS NOT A SENT MESSAGE: it keeps the row so
-- the content is not lost and the person can try again, and `sent_at` stays null so it never appears
-- in Sent. That is the same rule the invoice send already follows.
CREATE TABLE IF NOT EXISTS outbound_emails (
  id                SERIAL PRIMARY KEY,
  -- The author. Every query is scoped to this; nobody reads or edits another persons drafts.
  user_id           INTEGER NOT NULL,
  -- The mailbox it is written from, which is what keeps CRM and Desk apart.
  account_id        INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  status            VARCHAR(16) NOT NULL DEFAULT 'draft',
  to_emails         TEXT NULL,
  cc_emails         TEXT NULL,
  bcc_emails        TEXT NULL,
  subject           VARCHAR(998) NULL,
  body_html         TEXT NULL,
  body_text         TEXT NULL,
  -- Threading, so a reply joins the conversation instead of starting one.
  in_reply_to       VARCHAR(512) NULL,
  references_header TEXT NULL,
  thread_key        VARCHAR(512) NULL,
  -- The Message-ID this application generated for the sent copy.
  message_id        VARCHAR(512) NULL,
  sent_at           TIMESTAMP(0) NULL,
  -- Why the last attempt failed, shown on the draft so the person knows what to fix.
  error             VARCHAR(500) NULL,
  created_at        TIMESTAMP(0) NULL,
  updated_at        TIMESTAMP(0) NULL
);
CREATE INDEX IF NOT EXISTS outbound_emails_mailbox_idx
  ON outbound_emails (user_id, account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_emails_thread_idx ON outbound_emails (user_id, thread_key);

CREATE TABLE IF NOT EXISTS outbound_email_attachments (
  id            SERIAL PRIMARY KEY,
  email_id      INTEGER NOT NULL REFERENCES outbound_emails(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  filename      VARCHAR(255) NOT NULL,
  mime          VARCHAR(255) NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  storage_path  VARCHAR(512) NOT NULL,
  created_at    TIMESTAMP(0) NULL
);
CREATE INDEX IF NOT EXISTS outbound_email_attachments_email_idx ON outbound_email_attachments (email_id);
