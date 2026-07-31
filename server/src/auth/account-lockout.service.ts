import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ACCOUNT_LOGIN_LIMIT } from '../config/rate-limits';

/**
 * Failed sign-ins counted per ACCOUNT, not per address.
 *
 * This exists so the per-IP sign-in limit can be generous. Those two limits answer different
 * questions and conflating them is what made the old configuration untenable:
 *
 *   per IP       "is one network making an unreasonable number of attempts?"  — and a brokerage
 *                office is one network, so at 10 per 5 minutes the eleventh colleague to arrive at
 *                9 a.m. could not sign in, having done nothing wrong.
 *   per account  "is somebody guessing THIS person's password?" — which is the actual attack, and
 *                which an attacker escapes trivially by changing address if it is only counted per
 *                IP.
 *
 * Raising the per-IP number without adding this would have traded a real security control for
 * convenience. Together, an office of any size signs in freely while any single account still only
 * offers a handful of guesses per window from every address on earth combined.
 *
 * ONLY FAILURES COUNT, and a success clears the record. Somebody who signs in correctly is never
 * affected however often they do it, which is what keeps this invisible to honest use.
 *
 * IN-PROCESS AND DELIBERATELY SO. Counting in memory means a restart forgives everyone and a second
 * API process keeps its own tally. Both are acceptable here: this is a brake on online guessing,
 * not an audit trail, and the password hashing (bcrypt at cost 12) is what actually makes guessing
 * expensive. Persisting it would mean a write on every failed attempt — an unauthenticated,
 * attacker-controlled write — which is a worse trade. Move this to shared storage if the API is
 * ever run as more than one process AND that tradeoff stops being acceptable.
 */
@Injectable()
export class AccountLockoutService {
  private readonly failures = new Map<string, { count: number; firstAt: number }>();

  /** Normalised so `Agent@x.test` and `agent@x.test` cannot be attacked as separate accounts. */
  private key(username: string): string {
    return username.trim().toLowerCase();
  }

  /** Throws 429 when this account has too many recent failures. Call BEFORE verifying a password. */
  assertNotLocked(username: string): void {
    const rec = this.failures.get(this.key(username));
    if (!rec) return;

    const age = Date.now() - rec.firstAt;
    if (age > ACCOUNT_LOGIN_LIMIT.ttl) {
      this.failures.delete(this.key(username));
      return;
    }
    if (rec.count < ACCOUNT_LOGIN_LIMIT.limit) return;

    const retryAfter = Math.ceil((ACCOUNT_LOGIN_LIMIT.ttl - age) / 1000);
    throw new HttpException(
      {
        message: `Too many failed sign-in attempts for this account. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
        retry_after: retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Record a failed attempt. The window starts at the FIRST failure and does not slide. */
  recordFailure(username: string): void {
    const k = this.key(username);
    const rec = this.failures.get(k);
    if (!rec || Date.now() - rec.firstAt > ACCOUNT_LOGIN_LIMIT.ttl) {
      this.failures.set(k, { count: 1, firstAt: Date.now() });
      return;
    }
    rec.count += 1;

    // Opportunistic sweep. Without it the map is an unbounded, attacker-controlled allocation:
    // one entry per distinct username tried, forever. Cheap because it only runs on failures.
    if (this.failures.size > 5_000) this.sweep();
  }

  /** A correct password clears the account's history. */
  clear(username: string): void {
    this.failures.delete(this.key(username));
  }

  private sweep(): void {
    const cutoff = Date.now() - ACCOUNT_LOGIN_LIMIT.ttl;
    for (const [k, v] of this.failures) if (v.firstAt < cutoff) this.failures.delete(k);
  }
}
