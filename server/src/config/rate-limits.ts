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
