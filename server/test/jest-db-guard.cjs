/*
 * ================================================================================================
 * THE TEST SUITE MUST NEVER BE POINTED AT PRODUCTION, AND UNTIL NOW NOTHING STOPPED IT.
 *
 * `jest.config.js` carried no setup file, so a jest run inherited whatever `DATABASE_URL` the
 * shell had. On the deploy host that is `server/.env` — the LIVE database — because Prisma loads
 * that file automatically. `scripts/test-gate.cjs` spawns jest with no `env` of its own, so the
 * deployment gate was running the whole suite against production.
 *
 * WHAT THAT ACTUALLY DID. Every spec here writes inside a transaction it rolls back, so production
 * rows were not modified. The damage was the other direction: the specs READ. Services under test
 * sweep whole tables — `ReminderSweepService.sweep()`, `LeadWelcomeService.sweep()` — and inside a
 * rollback those sweeps see every committed production row alongside the fixture. So real deals
 * decided test outcomes. The gate failure that prompted this reported trade 200889 / transaction
 * 79967 by name: a live record, in a test log, changing an assertion.
 *
 * It also meant a deployment gate whose result depended on the state of the business that morning
 * — green or red according to which deals happened to be outstanding. That is not a gate.
 *
 * ------------------------------------------------------------------------------------------------
 * HOW THIS FIXES IT. `setupFiles` runs before a test module is loaded, which matters: every spec
 * constructs `new PrismaClient()` at module scope, reading `DATABASE_URL` as it does. Re-pointing
 * the variable here therefore lands before any client exists. Doing it in `setupFilesAfterEnv`
 * would be too late.
 *
 *   TEST_DATABASE_URL set  ->  it becomes DATABASE_URL for the run.
 *   not set                ->  DATABASE_URL must itself name a test database, or the run stops.
 *
 * FAIL CLOSED, DELIBERATELY. A misconfigured host gets a stopped run and a message naming the
 * database, not a silent fallback to whatever was in the environment — the silent fallback is the
 * bug being fixed. The same rule, and the same wording, already guard the Playwright suite in
 * `e2e/playwright.config.ts`; this is that rule applied to the half that lacked it.
 *
 * The name test is deliberately about the DATABASE, not the host: a database called `myapp` is not
 * safe merely because it sits on localhost, and one called `myapp_test` is safe wherever it lives.
 * ================================================================================================
 */

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';

if (!url) {
  throw new Error(
    'No database URL for the test run.\n\n'
    + '  Set TEST_DATABASE_URL to a database the suite may write to and roll back, e.g.\n'
    + '    TEST_DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/myapp_test?schema=public"\n',
  );
}

/** The database name only — credentials and host are never read, logged or compared. */
const name = (() => {
  try { return new URL(url).pathname.replace(/^\//, '').split('?')[0] || '(none)'; } catch { return '(unparseable)'; }
})();

if (!/test|staging|qa|scratch/i.test(name) || /prod/i.test(name)) {
  throw new Error(
    `Refusing to run the test suite against "${name}".\n\n`
    + '  These specs sweep whole tables and seed rows of their own. Against a database holding real\n'
    + '  records their results depend on that data, which is how the deployment gate came to report\n'
    + '  live transactions by trade number.\n\n'
    + '  The database NAME must identify it as a test database (test / staging / qa / scratch) and\n'
    + '  must not look like production. Point TEST_DATABASE_URL at one:\n\n'
    + '    TEST_DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/myapp_test?schema=public"\n\n'
    + '  Create it once with:  DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy\n',
  );
}

// Everything downstream — Prisma clients built at module scope in each spec — reads this.
process.env.DATABASE_URL = url;
