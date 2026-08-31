-- TD-086: the broker of record was a string literal in the client, correct today and silently
-- wrong the day it changes, on a signed document that reaches clients. Seeded with the current
-- value on purpose: nothing changes now, the name simply becomes data the brokerage owns.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS deposit_signatory VARCHAR(255);
UPDATE company_settings SET deposit_signatory = 'Anand Pericherla' WHERE deposit_signatory IS NULL;
