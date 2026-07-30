-- Inventory, MLS and Favorites moved from shared to the Transaction Desk, so their audit rows move
-- with them.
--
-- The alternative was to leave history alone and let the classifier disagree with what is stored.
-- That costs the property that makes the trail checkable — that every stored domain can be
-- re-derived from the row it came from — and leaves entries for a module the CRM no longer has
-- showing up in the CRM's trail, where the filter category for them no longer even exists.
--
-- This rewrites a filing column, not an event. Who did what, when, and the old and new values are
-- untouched; only which of the two trails the entry appears in changes.
UPDATE "audit_logs"
   SET "domain" = 'desk'
 WHERE "category" IN ('Marketing Inventory', 'Inventory', 'MLS', 'Favorites')
   AND "domain" IS DISTINCT FROM 'desk';
