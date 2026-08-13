import { seconds } from '@nestjs/throttler';

/**
 * Plain numbers rather than `ThrottlerOptions`, whose `ttl`/`limit` are typed as
 * `number | (context) => number` — which is assignable where these are used but blocks any
 * arithmetic on them, including the checks that assert one limit is stricter than the other.
 */
export interface Limit { ttl: number; limit: number }

const int = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Rate limits, kept in one place because the way they compose is a trap.
 *
 * EVERY throttler listed in `ThrottlerModule.forRoot` is enforced against EVERY route. Adding a
 * second, stricter bucket here to cover sign-in does not scope it to sign-in — it applies to the
 * whole API, so the eleventh request of any kind (a page load, an auto-save) returns 429 and the
 * application stops working. The strict limits therefore live on the endpoints, as overrides of
 * the single global bucket, via `@Throttle(...)` and a route-scoped guard.
 *
 * WHY THESE ARE KEYED BY USER, NOT BY IP. A brokerage office shares one NAT address, so an
 * IP-keyed bucket is really a whole-office bucket: measured, one agent editing a transaction
 * generates about 50 requests a minute (the detail screen auto-saves on a 1.2 s debounce), so
 * roughly twelve people in one office exhausted the old 600/minute limit and their saves began
 * failing mid-edit. Raising the number would have papered over that; it does not fix the shape,
 * because the ceiling still depends on how many colleagues happen to be working.
 *
 * `IdentityThrottlerGuard` keys authenticated traffic by user id instead. The limit below is now
 * what ONE PERSON may do per minute, which is both far more generous for an office of any size and
 * strictly tighter on a runaway client than the old shared bucket was.
 *
 * Every value is overridable by environment variable, because the right numbers depend on office
 * size and none of them should require a rebuild to change.
 */

/**
 * The general bucket: per identity — per signed-in user, or per IP for anonymous traffic.
 *
 * AND PER ROUTE. This is easy to misread and worth stating plainly, because it is not what "600
 * requests per minute" sounds like. `ThrottlerGuard.generateKey` hashes the controller and handler
 * name into the key, so every endpoint keeps its own counter: one person gets 600/minute on
 * `PUT /api/transactions/:id` AND another 600 on `GET /api/leads`, independently. Verified against
 * a running server — six different endpoints each reported `X-RateLimit-Remaining: 599`.
 *
 * That makes this a per-endpoint runaway guard rather than an overall budget, which is the right
 * shape: the number only has to accommodate the busiest single endpoint, not the sum of everything
 * a person does. The busiest is the transaction detail screen's auto-save at ~50 requests/minute,
 * so 600 leaves an order of magnitude of headroom while still stopping a client stuck in a loop.
 *
 * Env: RATE_LIMIT_PER_MINUTE
 */
export const GLOBAL_LIMIT: Limit = {
  ttl: seconds(60),
  limit: int(process.env.RATE_LIMIT_PER_MINUTE, 600),
};

/**
 * Anonymous traffic, keyed by IP — everything before sign-in. A whole office shares this one, so
 * it is deliberately larger than the per-user limit above.
 *
 * Env: RATE_LIMIT_ANON_PER_MINUTE
 */
export const ANON_LIMIT: Limit = {
  ttl: seconds(60),
  limit: int(process.env.RATE_LIMIT_ANON_PER_MINUTE, 1200),
};

/**
 * Sign-in, registration and password change, keyed by IP.
 *
 * This one had the worst version of the NAT problem: at 10 attempts per 5 minutes per address, the
 * eleventh person to arrive at a 200-agent office at 9 a.m. simply could not sign in, having done
 * nothing wrong. The default is now sized for a whole office arriving at once.
 *
 * Raising it does NOT weaken brute-force protection, because that job has moved to
 * ACCOUNT_LOGIN_LIMIT below, which an attacker cannot escape by changing address. Keeping this
 * bucket at all still caps how fast one network can spray many different usernames.
 *
 * Env: AUTH_RATE_LIMIT_MAX / AUTH_RATE_LIMIT_WINDOW_SECONDS
 */
export const AUTH_LIMIT: Limit = {
  ttl: seconds(int(process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS, 300)),
  limit: int(process.env.AUTH_RATE_LIMIT_MAX, 120),
};

/**
 * Failed sign-ins for ONE ACCOUNT, regardless of where they come from. This is the actual
 * brute-force defence, and it is the reason the per-IP limit above can be generous.
 *
 * Counted per username and only on FAILURE, so a person who signs in correctly is never affected
 * no matter how many times they do it, and an attacker gets a handful of guesses per account per
 * window from every address on earth combined.
 *
 * Env: AUTH_ACCOUNT_LIMIT_MAX / AUTH_ACCOUNT_LIMIT_WINDOW_SECONDS
 */
export const ACCOUNT_LOGIN_LIMIT: Limit = {
  ttl: seconds(int(process.env.AUTH_ACCOUNT_LIMIT_WINDOW_SECONDS, 900)),
  limit: int(process.env.AUTH_ACCOUNT_LIMIT_MAX, 8),
};

/**
 * Manual "Sync Now" on the Meta screen, per user.
 *
 * WHY THIS ONE NEEDS ITS OWN BUCKET. Every other endpoint costs this application a little
 * database work. This one fans out to Meta: one Graph request per connected lead form, plus a
 * cursor walk of up to `META_MAX_LEADS_PER_FORM` per form. Graph rate limits are enforced **per
 * app**, not per user — so one person holding down Sync spends a budget that every other agent in
 * the brokerage draws from, and the symptom lands on them as failed syncs they did nothing to
 * cause.
 *
 * Six a minute is one every ten seconds, which is far more than a human has any reason to press:
 * the scheduler already polls every fifteen minutes, so a second press within ten seconds cannot
 * return anything the first did not. It exists to stop a stuck client or an impatient hand, not to
 * ration normal use.
 *
 * HONEST LIMITATION: this is keyed per user, like every bucket here, so it bounds one person
 * rather than the brokerage. Twenty agents at six a minute is still 120 calls a minute against one
 * app budget. Bounding the app as a whole needs a shared counter rather than a per-identity one,
 * which is a different mechanism; this closes the runaway case, which is the one actually observed.
 *
 * Env: META_SYNC_RATE_LIMIT_MAX / META_SYNC_RATE_LIMIT_WINDOW_SECONDS
 */
export const META_SYNC_LIMIT: Limit = {
  ttl: seconds(int(process.env.META_SYNC_RATE_LIMIT_WINDOW_SECONDS, 60)),
  limit: int(process.env.META_SYNC_RATE_LIMIT_MAX, 6),
};

/**
 * "Send to All Users" on CRM Settings, per user.
 *
 * WHY THIS ONE NEEDS ITS OWN BUCKET. The general limit is a per-endpoint runaway guard sized for a
 * screen that auto-saves — 600 a minute. That is the right number for a settings write, which costs
 * one row, and an absurd one for this endpoint, which fans out one SMTP round trip per active
 * member of staff and cannot be recalled. At 600 a minute a stuck client could put six hundred
 * messages into every inbox in the brokerage before anyone noticed.
 *
 * The identical-message guard in `CrmSettingsService.broadcast` catches the accidental repeat; it
 * does not catch a loop sending DIFFERENT messages, which is what this bounds. Three a minute is
 * more than a person announcing something has any reason to need, and the audit trail records each
 * one either way.
 *
 * Env: BROADCAST_RATE_LIMIT_MAX / BROADCAST_RATE_LIMIT_WINDOW_SECONDS
 */
export const BROADCAST_LIMIT: Limit = {
  ttl: seconds(int(process.env.BROADCAST_RATE_LIMIT_WINDOW_SECONDS, 60)),
  limit: int(process.env.BROADCAST_RATE_LIMIT_MAX, 3),
};

/**
 * Configuration writes — CRM Settings, CRM email settings, company settings — per user.
 *
 * WHAT THIS IS ACTUALLY FOR, because it is not load. One of these writes a single row; six hundred
 * a minute would not trouble the database. It is the AUDIT TRAIL. Every save here also writes an
 * entry ("CRM settings updated", "Banking details changed"), and the trail is the only record of who
 * changed the brokerage's bank account and when. A client stuck in a save loop under the general
 * 600-a-minute bucket buries that evidence under thousands of identical rows — measured 2026-08-04:
 * 40 consecutive `PUT /api/crm-settings` in a tight loop, all 200, all audited.
 *
 * DELIBERATELY NOT TIGHT. These are explicit Save buttons, not the transaction screen's 1.2 s
 * auto-save, so nothing here bursts — but a settings screen with several cards can legitimately fire
 * a handful of saves in quick succession while someone works through it, and a limit that refuses
 * the fourth would be a worse bug than the one it closes. Thirty a minute is one every two seconds,
 * sustained, for a minute: past any hand and well short of any real session.
 *
 * Env: SETTINGS_WRITE_RATE_LIMIT_MAX / SETTINGS_WRITE_RATE_LIMIT_WINDOW_SECONDS
 */
export const SETTINGS_WRITE_LIMIT: Limit = {
  ttl: seconds(int(process.env.SETTINGS_WRITE_RATE_LIMIT_WINDOW_SECONDS, 60)),
  limit: int(process.env.SETTINGS_WRITE_RATE_LIMIT_MAX, 30),
};
