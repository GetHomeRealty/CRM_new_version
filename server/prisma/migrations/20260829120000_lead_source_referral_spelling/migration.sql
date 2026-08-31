-- Correct the stored lead source 'refferal' to 'referral'.
--
-- WHY THIS IS A MIGRATION AND NOT A CODE CHANGE. The misspelling was never only a label: it was the
-- value written to `leads.lead_source`, so the brokerage's referral business is filed under a typo
-- and a filter for 'referral' matched nothing. The application now writes 'referral', reads both
-- spellings and displays both as "Referral", so nothing is stranded while this is unapplied - but
-- until it runs, the database holds two spellings of one thing, and every report, export and
-- ad-hoc SQL query anybody writes has to know that.
--
-- SAFE TO RUN AT ANY TIME, AND SAFE TO RUN TWICE. It touches only rows holding the exact legacy
-- value, and once they are converted the WHERE matches nothing. It does not alter any column type,
-- constraint or index, so it needs no downtime and no Prisma client regeneration.
--
-- IT INCLUDES SOFT-DELETED LEADS on purpose: a lead restored from Recently Deleted must not come
-- back carrying the old spelling and reintroduce it.
UPDATE leads
   SET lead_source = 'referral'
 WHERE lead_source = 'refferal';
