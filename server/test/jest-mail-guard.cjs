/*
 * ================================================================================================
 * THE TEST PROCESS CANNOT REACH A REAL MAILBOX. ENFORCED, NOT CONFIGURED.
 *
 * `local-mail-safety.spec.ts` used to establish this by reading `server/.env` and asserting the
 * deployment was set up so that it could not send: `MAIL_ALLOW_REAL_SEND` not truthy, a
 * `MAIL_REDIRECT_TO` present. On a developer's laptop that is exactly right, and it is why the file
 * exists — this deployment really had been mailing clients from a laptop on a scheduler.
 *
 * ON THE DEPLOY HOST IT IS THE WRONG QUESTION. Production must send real mail to real people; that
 * is its job. So the assertions failed there, and the only ways to make them pass were to rewrite
 * production's mail configuration to redirect — breaking the business to satisfy a test — or to
 * baseline the failures, which retires the one check that catches a genuinely unsafe machine.
 *
 * The property actually worth guaranteeing is narrower and universal: whatever the deployment is
 * configured to do, THIS PROCESS, the one running the suite, must not be able to reach anybody.
 * That does not depend on `.env` and is not in tension with production, so it is simply imposed.
 *
 *   MAIL_ALLOW_REAL_SEND  forced off
 *   MAIL_REDIRECT_TO      forced to an address reserved by RFC 2606 as unresolvable
 *   NODE_ENV              never 'production' in a test worker
 *
 * WHY ALL THREE. `MailerService.redirectTarget()` returns null — meaning "send for real" — on any
 * of: a production NODE_ENV, a truthy MAIL_ALLOW_REAL_SEND, or an explicit empty redirect. Setting
 * only one of them leaves the other two able to open the door, and the deploy host's own `.env`
 * supplies at least one of them by design.
 *
 * `setupFiles` runs before the test module is loaded, so this lands before any spec, mailer or
 * Nest module reads the environment. `scripts/test-gate.cjs` also passes these values into the
 * jest child; this is the inner of the two locks, and the one that also covers a developer running
 * `npx jest` by hand.
 * ================================================================================================
 */

/*
 * MAIL_REDIRECT_TO IS CLEARED, NOT SET, AND THAT DISTINCTION MATTERS.
 *
 * Setting it to a sink of our own looked like the stronger move and is the wrong one: the variable
 * is not only the mailer's business. `reminder-sweep.service.ts` reads it directly — `redirectTo()
 * ?? address` — so forcing a value there rewrites the RECIPIENT every sweep chooses, not merely
 * where the message lands. Measured: it emptied the fixture-scoped stubs in reminder-sweep and
 * reminder-renamed-agent, because the address they filter on had been replaced.
 *
 * Clearing it instead hands the decision back to `MailerService.redirectTarget()`, whose own safe
 * default is exactly what is wanted: not production, not allowed to send for real, therefore
 * DEV_SINK — an address RFC 2606 reserves as unresolvable. Application routing behaves as it does
 * in a normal development process, and nothing can leave.
 */
process.env.MAIL_ALLOW_REAL_SEND = '0';
process.env.MAIL_REDIRECT_TO = '';

/*
 * S-1. The identity, imposed rather than inherited. `redirectTarget()` now asks four questions
 * instead of one, and a test worker must fail the FIRST of them however the host is configured —
 * so APP_ENV is pinned here alongside the two above. A runner that picked up `APP_ENV=production`
 * from the deploy host's environment would otherwise have three of the four already satisfied.
 */
process.env.APP_ENV = 'test';

// A worker that believes it is production would send for real whatever the two above say, because
// `redirectTarget()` checks NODE_ENV before either of them.
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

module.exports = {};
