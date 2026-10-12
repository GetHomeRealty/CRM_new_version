-- Which mailbox a campaign was told to send from, and which one it actually sent from.
--
-- WHY. The sender was resolved at delivery and never written down, so the one question somebody
-- asks after the fact — "which address did these four hundred clients see?" — had no answer in the
-- database. `MailAccountService.senderFor` ends, when a brokerage has connected no shared mailbox,
-- in "any active account, in id order", which is a colleague's; that is a recorded incident, not a
-- hypothetical. Storing the result is what makes it checkable.
--
-- BOTH COLUMNS ARE NULLABLE WITH NO DEFAULT, so every existing campaign keeps reading exactly as it
-- does now and no backfill pass is needed. NULL in `sender_account_id` is not "unknown", it is the
-- behaviour this CRM has always had: resolve a sender at send time. NULL in `sender_email` means
-- the campaign pre-dates this column or never reached the point of resolving one, and screens say
-- "not recorded" rather than inventing an address.
--
-- NO FOREIGN KEY ON `sender_account_id`, which is a decision rather than an omission. Both
-- referential actions are wrong for a historical record: ON DELETE SET NULL erases which account
-- was used the moment a mailbox is disconnected, and ON DELETE RESTRICT makes a campaign sent last
-- year block the removal of a mailbox today. Display reads `sender_email`, so an id left pointing
-- at a deleted row costs nothing and still records what the send resolved.
--
-- NO INDEX. Nothing queries campaigns BY sender — these columns are read as part of a campaign
-- already located by id or by `created_by_id`. An index the schema does not declare would also show
-- up forever as drift against `migrate diff`.
ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "sender_account_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "sender_email" VARCHAR(255);
