-- Give the CRM a BROKERAGE primary mailbox, so the sender is CHOSEN rather than inherited.
--
-- WHY THIS IS NEEDED. Clients received mail from a colleague's address — the "sent through Veena"
-- report. Nobody chose that; the sender lookup did. Every mail account in this system belongs to a
-- PERSON, so every shared-account lookup in `MailAccountService.defaultSender` misses and resolution
-- falls through to "somebody's personal CRM account", taken in id order. Which colleague that is, is
-- an accident of which row sorts first.
--
-- `is_default` DOES NOT MEAN "the brokerage's primary". It is stored per owner, which is why several
-- accounts each carry is_default = true — they are several people's own defaults. `setDefault` calls
-- `makeSoleDefault(id, existing.user_id, scope)`, so it only ever clears the defaults of THAT
-- account's owner. Marking a personally-owned account primary therefore cannot be brokerage-wide,
-- however many times the button is pressed.
--
-- WHAT THE CODE CHANGE DID, AND WHAT IS LEFT FOR THIS SCRIPT. `senderFor` and `resolveSender` now
-- consult a brokerage primary — an account with `user_id IS NULL`, `is_default`, `is_active` — BEFORE
-- the sender's own mailbox, which is the precedence that was missing. Both are inert until such a row
-- exists. Creating one is the only step SQL is needed for, and only because the mailbox you want is
-- currently owned by a person; a brokerage account added through admin Email Settings is already
-- `user_id IS NULL` and needs nothing here.
--
-- MATCHED BY ADDRESS, NOT ID. Ids differ between databases; the development id means nothing here.
-- Check the SELECT at the top against your own data before committing.

BEGIN;

-- ---- 1. Look first. This is the list that decides everything below.
SELECT m.id, m.from_email, m.user_id, u.name AS owner, m.scope,
       m.is_active, m.is_default, m.inbound_enabled, m.imap_host
  FROM mail_accounts m
  LEFT JOIN users u ON u.id = m.user_id
 WHERE m.scope = 'crm' OR m.scope IS NULL
 ORDER BY (m.user_id IS NULL) DESC, m.is_default DESC, m.id;

-- ---- 2. Promote ONE account to the brokerage's own.
--
-- Change the address if you want a different mailbox. It must already hold working credentials —
-- this moves ownership, it does not create a login. `is_active` is forced true because an inactive
-- primary would be skipped and the old fall-through would resume.
--
-- NOTE THE COST: the account leaves its owner's personal list and becomes the brokerage's. After
-- this, that person no longer sees it under their own email settings. Pick an address that is
-- genuinely the brokerage's, not somebody's working mailbox.
UPDATE mail_accounts
   SET user_id    = NULL,
       is_default = true,
       is_active  = true,
       scope      = 'crm',
       updated_at = now()
 WHERE id = (
   SELECT id FROM mail_accounts
    WHERE lower(from_email) = lower('info@gethomerealty.ca')
      AND (scope = 'crm' OR scope IS NULL)
      AND is_active = true
    ORDER BY id
    LIMIT 1
 );

-- ---- 3. One brokerage CRM primary, not several.
-- `makeSoleDefault` keeps this invariant when the app sets a default; this keeps it here too.
UPDATE mail_accounts
   SET is_default = false, updated_at = now()
 WHERE user_id IS NULL
   AND (scope = 'crm' OR scope IS NULL)
   AND is_default = true
   AND lower(from_email) <> lower('info@gethomerealty.ca');

-- ---- 4. Verification. Must return exactly ONE row before you COMMIT, and it must be the address
--         you intended. This is the row the application will now send every CRM message from.
SELECT id, from_email, user_id, scope, is_active, is_default, inbound_enabled, imap_host
  FROM mail_accounts
 WHERE user_id IS NULL
   AND (scope = 'crm' OR scope IS NULL)
   AND is_default = true
   AND is_active = true;

-- ---- 5. RECEIVING is a separate switch, and step 4 shows whether it is on.
--
-- `ImapSyncService.pollAll` fetches from every account with `inbound_enabled = true`, `is_active` and
-- an `imap_host` set. It does NOT filter on the owner, so a brokerage mailbox is polled like any
-- other — but only once those two columns are populated. If step 4 showed inbound_enabled = false or
-- imap_host = NULL, mail will be SENT from this address and nothing will be fetched back.
--
-- ONE THING SQL CANNOT FIX, and it is a decision rather than a defect. `permittedAccountIds` in
-- src/inbox/mailbox-scope.ts returns only rows where `user_id = <the viewer>`, so a brokerage-owned
-- mailbox sits in NO agent's permitted set: its mail is fetched and stored, and no agent's Inbox
-- screen lists it. Whether every agent should see the brokerage inbox is a privacy question for the
-- brokerage to answer, so it is deliberately not changed here.

-- COMMIT;     -- uncomment once step 4 returns exactly one row, and it is the right address
ROLLBACK;      -- remove this line when you are ready to commit
