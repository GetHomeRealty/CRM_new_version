import * as fs from 'fs';
import * as path from 'path';
import { ACCOUNT_LOGIN_LIMIT, ANON_LIMIT, AUTH_LIMIT, GLOBAL_LIMIT } from './rate-limits';

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
    // run each minute, and one request goes out per navigation. This bucket is now per USER, so
    // this is what one person may do, not what an office may do between them.
    expect(GLOBAL_LIMIT.limit).toBeGreaterThanOrEqual(300);
    expect(GLOBAL_LIMIT.ttl).toBe(60_000);
  });

  it('keys the global bucket by user, so an office does not share one ceiling', () => {
    // The regression this guards is subtle and total: reverting to the stock ThrottlerGuard makes
    // the limit IP-keyed again, and since a whole office is one NAT address, ~12 people editing
    // would exhaust it and their auto-saves would start failing mid-edit.
    const app = read('../app.module.ts');
    expect(app).toContain('useClass: IdentityThrottlerGuard');
    expect(app).not.toMatch(/useClass:\s*ThrottlerGuard/);

    const guard = read('../core/identity-throttler.guard.ts');
    expect(guard).toContain('session');   // identity read from the session, not from AuthGuard
    expect(guard).toMatch(/return `u:\$\{userId\}`/);
  });

  it('gives anonymous traffic its own, larger bucket', () => {
    // Before anyone signs in there is no user to key on, so a whole office really does share one
    // address — and the sign-in page itself must stay usable at 9 a.m.
    expect(ANON_LIMIT.limit).toBeGreaterThan(GLOBAL_LIMIT.limit);
    expect(ANON_LIMIT.ttl).toBe(60_000);
  });

  it('lets a whole office sign in without letting one account be guessed', () => {
    // These two limits answer different questions, and the per-IP one CANNOT do the second job:
    // an office is one address, so any per-IP limit low enough to stop guessing also stops the
    // eleventh colleague to arrive. The per-account limit is what makes guessing futile, and it is
    // what allows the per-IP limit to be generous.
    expect(AUTH_LIMIT.limit).toBeGreaterThanOrEqual(60);        // an office arriving at once
    expect(ACCOUNT_LOGIN_LIMIT.limit).toBeLessThanOrEqual(10);  // per account, per window
    expect(ACCOUNT_LOGIN_LIMIT.limit).toBeGreaterThanOrEqual(3);// tolerate a mistyped password
    expect(ACCOUNT_LOGIN_LIMIT.ttl).toBeGreaterThanOrEqual(300_000);
  });

  it('counts failed sign-ins per account and clears them on success', () => {
    const svc = read('../auth/account-lockout.service.ts');
    // Normalised, or the same account can be attacked as several by varying case.
    expect(svc).toContain('toLowerCase()');

    const auth = read('../auth/auth.service.ts');
    // Checked BEFORE the password is verified, so a locked account costs no bcrypt work.
    expect(auth).toMatch(/assertNotLocked\(login\);[\s\S]*findAuthenticatable/);
    expect(auth).toContain('this.lockout.recordFailure(login)');
    expect(auth).toContain('this.lockout.clear(login)');
  });

  it('makes both sign-in limits far stricter than the general one', () => {
    const globalPerSecond = GLOBAL_LIMIT.limit / (GLOBAL_LIMIT.ttl / 1000);
    const authPerSecond = AUTH_LIMIT.limit / (AUTH_LIMIT.ttl / 1000);
    const accountPerSecond = ACCOUNT_LOGIN_LIMIT.limit / (ACCOUNT_LOGIN_LIMIT.ttl / 1000);
    expect(authPerSecond).toBeLessThan(globalPerSecond / 10);
    expect(accountPerSecond).toBeLessThan(globalPerSecond / 500);
  });

  it('reads every limit from the environment, so tuning needs no rebuild', () => {
    const src = read('./rate-limits.ts');
    for (const key of [
      'RATE_LIMIT_PER_MINUTE',
      'RATE_LIMIT_ANON_PER_MINUTE',
      'AUTH_RATE_LIMIT_MAX',
      'AUTH_RATE_LIMIT_WINDOW_SECONDS',
      'AUTH_ACCOUNT_LIMIT_MAX',
      'AUTH_ACCOUNT_LIMIT_WINDOW_SECONDS',
    ]) expect(src).toContain(`process.env.${key}`);
  });

  it('ignores nonsense environment values rather than disabling the limits', () => {
    // `RATE_LIMIT_PER_MINUTE=` or `=abc` must not resolve to 0 or NaN — either would mean every
    // request is throttled, or none is. The parser falls back instead.
    const src = read('./rate-limits.ts');
    expect(src).toMatch(/Number\.isFinite\(n\) && n > 0/);
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
