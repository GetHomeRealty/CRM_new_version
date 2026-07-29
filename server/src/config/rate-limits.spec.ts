import * as fs from 'fs';
import * as path from 'path';
import { AUTH_LIMIT, GLOBAL_LIMIT } from './rate-limits';

/**
 * Guards the one mistake that turns rate limiting into an outage.
 *
 * Every throttler passed to `ThrottlerModule.forRoot` is enforced against every route. Declaring
 * the strict sign-in limit as a second bucket there reads as "10 attempts per 5 minutes on auth"
 * and actually means "10 requests per 5 minutes on the whole API" — so the eleventh page load or
 * auto-save returns 429 and the application stops working. This was observed against a running
 * server, not theorised.
 *
 * The invariant is checked against the source text rather than by importing AppModule, because
 * importing it drags in the entire dependency graph — including an ESM-only package Jest cannot
 * parse — for a fact that is plainly visible in one line.
 */
describe('rate limit configuration', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  it('registers exactly one global throttler bucket', () => {
    const src = read('../app.module.ts');
    const call = /ThrottlerModule\.forRoot\(\s*\[([^\]]*)\]/.exec(src);
    expect(call).not.toBeNull();

    const entries = (call?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    expect(entries).toEqual(['GLOBAL_LIMIT']);
  });

  it('applies the strict limit at the endpoints instead, where it can be scoped', () => {
    const auth = read('../auth/auth.controller.ts');
    // login, register and password change.
    expect(auth.match(/@Throttle\(\{ default: AUTH_LIMIT \}\)/g)).toHaveLength(3);
  });

  it('keeps the global bucket generous enough for normal use', () => {
    // A transaction being edited auto-saves on a 1.2 s debounce (~50/min), two notification polls
    // run each minute, and a whole office can share one NAT address and so one bucket. A limit
    // near those numbers would surface as saves failing mid-edit.
    expect(GLOBAL_LIMIT.limit).toBeGreaterThanOrEqual(300);
    expect(GLOBAL_LIMIT.ttl).toBe(60_000);
  });

  it('keeps the auth limit strict enough to stop guessing but not a mistyped password', () => {
    expect(AUTH_LIMIT.limit).toBeLessThanOrEqual(10);
    expect(AUTH_LIMIT.limit).toBeGreaterThanOrEqual(5);
    expect(AUTH_LIMIT.ttl).toBeGreaterThanOrEqual(60_000);
  });

  it('makes the auth limit dramatically stricter than the global one', () => {
    const globalPerSecond = GLOBAL_LIMIT.limit / (GLOBAL_LIMIT.ttl / 1000);
    const authPerSecond = AUTH_LIMIT.limit / (AUTH_LIMIT.ttl / 1000);
    expect(authPerSecond).toBeLessThan(globalPerSecond / 100);
  });

  it('exempts provider webhooks, where a throttled burst loses real data', () => {
    // Twilio status callbacks arrive one per recipient during a bulk send; Meta delivers lead
    // spikes; mail gateways prefetch tracking pixels. Turning those away drops data rather than
    // an attacker.
    for (const rel of [
      '../sms/sms-public.controller.ts',
      '../twilio-voice/twilio-voice-public.controller.ts',
      '../meta/meta-public.controller.ts',
      '../campaigns/campaign-tracking.controller.ts',
    ]) {
      expect(read(rel)).toContain('@SkipThrottle()');
    }
  });
});
