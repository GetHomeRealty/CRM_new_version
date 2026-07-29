import { seconds } from '@nestjs/throttler';

/**
 * Plain numbers rather than `ThrottlerOptions`, whose `ttl`/`limit` are typed as
 * `number | (context) => number` — which is assignable where these are used but blocks any
 * arithmetic on them, including the checks that assert one limit is stricter than the other.
 */
interface Limit { ttl: number; limit: number }

/**
 * Rate limits, kept in one place because the way they compose is a trap.
 *
 * EVERY throttler listed in `ThrottlerModule.forRoot` is enforced against EVERY route. Adding a
 * second, stricter bucket here to cover sign-in does not scope it to sign-in — it applies to the
 * whole API, so the eleventh request of any kind (a page load, an auto-save) returns 429 and the
 * application stops working. The strict limit therefore lives on the endpoints, as an override of
 * the single global bucket, via `@Throttle({ default: AUTH_LIMIT })`.
 */

/**
 * The global bucket. A runaway guard, not a user-facing limit, and deliberately generous: the
 * transaction detail screen auto-saves every field on a 1.2 s debounce, two notification polls
 * run every minute, and an entire office can share one NAT address and therefore one bucket. Set
 * this too low and it surfaces as saves failing mid-edit, which is worse than what it prevents.
 */
export const GLOBAL_LIMIT: Limit = { ttl: seconds(60), limit: 600 };

/**
 * Sign-in, registration and password change. These are the endpoints where repetition IS the
 * attack. Low enough that guessing is pointless, high enough that a person mistyping their own
 * password several times is unaffected.
 */
export const AUTH_LIMIT: Limit = { ttl: seconds(300), limit: 10 };
