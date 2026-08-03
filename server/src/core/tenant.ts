/**
 * The brokerage this deployment serves.
 *
 * THE PRODUCT IS SINGLE-BROKERAGE TODAY. That is a decision, recorded here because the schema
 * says something else and the gap between the two is what makes it dangerous to leave implicit.
 *
 * `company_settings` IS the tenant table — `users`, `leads`, `transactions`, `campaigns`,
 * `invoices` and fourteen more carry a `company_id` referencing its `id`, and `tenancy.spec.ts`
 * asserts that every root table has the column. The groundwork for several brokerages in one
 * database is laid. Nothing uses it: every Settings query resolves row 1, and before this constant
 * existed several of them did so by accident rather than on purpose —
 * `crm_email_settings` was read with `findFirst({ orderBy: { id: 'asc' } })` and no tenant filter
 * at all, which on a second brokerage would have returned whichever row happened to have the lowest
 * id and silently governed both.
 *
 * WHAT THIS CONSTANT IS FOR. It is not a step toward multi-tenancy and does not enable it. It makes
 * the single-tenant assumption one named, greppable thing instead of a bare `1` repeated across
 * four files, so that the day the brokerage opens a second office the work is "find every use of
 * this and resolve it from the session" rather than "find every literal 1 and work out which ones
 * meant the tenant".
 *
 * WHAT IS STILL NOT DONE, stated so nobody reads this as the fix: resolving the tenant from the
 * session, filtering the Settings reads on it, and giving each brokerage its own invoice counter.
 * Until then a second `company_settings` row is invisible to Settings, and creating one would be a
 * bug rather than a feature. See docs/audit/CRM-SETTINGS-AUDIT.md, finding S-H5.
 */
export const TENANT_ID = 1;
