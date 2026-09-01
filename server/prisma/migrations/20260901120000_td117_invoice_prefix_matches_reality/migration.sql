-- TD-117: Company Settings' Invoice Prefix is set to the prefix invoices actually carry.
--
-- WHAT WAS WRONG. `invoice_prefix` held 'INV-' while every transaction invoice in the system read
-- GHR- — GHR-001 … GHR-007 and the brokerage's own GHR-200836. An administrator opening Company
-- Settings to learn how invoices are numbered was told the wrong answer, and would reasonably have
-- expected changing the field to change the numbering.
--
-- THE QUESTION THE DEFECT LEFT OPEN IS ANSWERED, AND THE ANSWER IS THE LESS TIDY ONE. The field was
-- not merely unused: TWO NUMBERING SCHEMES EXISTED SIDE BY SIDE. `InvoiceNumberService.next()`
-- honoured the setting and produced INV-601107; `forTransaction()` hardcoded 'GHR-'. Almost every
-- invoice comes from a transaction, so almost every invoice used the scheme nobody had configured,
-- and the counter behind the other one had still advanced ten times. Both are present in the data.
--
-- WHY THIS MIGRATION IS NOT OPTIONAL. The code change makes `forTransaction` read this field. On
-- its own that would silently move new invoices from GHR- to INV- — renumbering a live series that
-- the brokerage quotes to clients and to its accountant. This sets the stored value to what is
-- already in use FIRST, so the code change alters no invoice number at all: it only makes the
-- setting true, and makes changing it work from then on.
--
-- SCOPE. Only where the field still holds the untouched default. If somebody deliberately set
-- another prefix, that was a decision — it was being ignored for transaction invoices and honoured
-- for the counter, and reversing it is not this migration's business.
--
-- ON THE COUNTER, which the defect asked to be checked: `next_invoice_no` is a SEPARATE series from
-- the trade numbers `forTransaction` uses, so aligning the prefix does not merge them. A collision
-- would need a trade number equal to a counter value (601117 and rising); trade numbers run in the
-- 200000s. Worth knowing rather than worth guarding.
--
-- REVERSIBLE. To undo: set it back to 'INV-' and revert the code together — the two belong to one
-- change and separating them is what renumbers invoices.
--
-- DML ONLY. No ALTER TABLE, CREATE TABLE or CREATE INDEX. The column's schema default is
-- deliberately left as 'INV-' for the same reason: changing it would require altering the table,
-- which the application's database user cannot do.

UPDATE "company_settings"
   SET "invoice_prefix" = 'GHR-',
       "updated_at" = NOW()
 WHERE "invoice_prefix" IS NULL
    OR "invoice_prefix" = 'INV-';
