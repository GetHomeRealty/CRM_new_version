import { MailerService } from './mailer.service';

/**
 * Where outgoing mail actually goes, decided in one place.
 *
 * WHY THIS FILE EXISTS. On 2026-08-06 a development server, running against the development
 * database, delivered real `lead_task_due` notifications to real people. Nothing was misconfigured —
 * `MAIL_REDIRECT_TO` was simply absent, and absent used to mean "send it". The rule below inverts
 * that default outside production, and this file pins the inversion down, because a safety default
 * that nobody tests is a safety default that a future refactor removes without noticing.
 *
 * The two directions matter equally:
 *   - a non-production process must NOT reach a real recipient by default, and
 *   - production behaviour must be EXACTLY what it was, because silently swallowing a brokerage's
 *     client mail would be a far worse bug than the one being fixed.
 */

describe('where outgoing mail goes', () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    MAIL_REDIRECT_TO: process.env.MAIL_REDIRECT_TO,
    MAIL_ALLOW_REAL_SEND: process.env.MAIL_ALLOW_REAL_SEND,
  };

  const set = (env: Partial<typeof saved>) => {
    for (const k of Object.keys(saved) as (keyof typeof saved)[]) {
      const v = env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  afterEach(() => {
    // Restore exactly, including "was not set at all" — leaving NODE_ENV altered would change the
    // behaviour of every suite that runs after this one.
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('outside production', () => {
    it('diverts to the sink when nothing is configured — the case that caused the incident', () => {
      set({ NODE_ENV: 'development' });
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
    });

    it('the sink can never resolve, so an escaped message still reaches nobody', () => {
      // RFC 2606 reserves `.invalid` precisely so that it is guaranteed not to exist.
      expect(MailerService.DEV_SINK).toMatch(/\.invalid$/);
    });

    it('an explicit MAIL_REDIRECT_TO wins, so a developer can read their own test mail', () => {
      set({ NODE_ENV: 'development', MAIL_REDIRECT_TO: 'me@example.test' });
      expect(MailerService.redirectTarget()).toBe('me@example.test');
    });

    it('MAIL_ALLOW_REAL_SEND restores real delivery, deliberately and explicitly', () => {
      set({ NODE_ENV: 'development', MAIL_ALLOW_REAL_SEND: '1' });
      expect(MailerService.redirectTarget()).toBeNull();
    });

    it.each(['true', 'yes', 'on', 'TRUE'])('accepts %s as the escape hatch', (v) => {
      set({ NODE_ENV: 'development', MAIL_ALLOW_REAL_SEND: v });
      expect(MailerService.redirectTarget()).toBeNull();
    });

    it.each(['0', 'false', 'no', '', 'maybe'])('does NOT treat %p as permission to send', (v) => {
      set({ NODE_ENV: 'development', MAIL_ALLOW_REAL_SEND: v });
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
    });

    it('an unset NODE_ENV is treated as not-production — the safe reading', () => {
      set({});
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
    });

    it('the test environment is covered too, so a suite cannot mail a client', () => {
      set({ NODE_ENV: 'test' });
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
    });
  });

  describe('in production, behaviour is unchanged', () => {
    it('sends normally when no redirect is configured', () => {
      set({ NODE_ENV: 'production' });
      expect(MailerService.redirectTarget()).toBeNull();
    });

    it('still honours MAIL_REDIRECT_TO, for a staging environment that sets it', () => {
      set({ NODE_ENV: 'production', MAIL_REDIRECT_TO: 'sink@example.test' });
      expect(MailerService.redirectTarget()).toBe('sink@example.test');
    });

    it('IGNORES MAIL_ALLOW_REAL_SEND — production never needed permission', () => {
      set({ NODE_ENV: 'production', MAIL_ALLOW_REAL_SEND: '1' });
      expect(MailerService.redirectTarget()).toBeNull();
    });

    it('a blank MAIL_REDIRECT_TO means "not set", not "send to the empty address"', () => {
      set({ NODE_ENV: 'production', MAIL_REDIRECT_TO: '   ' });
      expect(MailerService.redirectTarget()).toBeNull();
    });
  });
});
