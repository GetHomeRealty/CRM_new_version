import { readFileSync } from 'fs';
import { join } from 'path';
import { PasswordResetService } from './password-reset.service';
import { PasswordHashService } from './password-hash.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Forgotten-password, and the properties that make it safe to expose without a session.
 *
 * This endpoint is reachable by anyone on the internet, so most of what is asserted here is about
 * what it must REFUSE to reveal or allow:
 *
 *   · the same answer for a real address, an unknown one and a disabled account, so it cannot be
 *     used to find out who banks with the brokerage;
 *   · the token stored only as a SHA-256, so a database copy yields nothing replayable;
 *   · single use, time limited, and superseded by the next request;
 *   · every existing session ended, because revoking access obtained with the old password is most
 *     of the reason somebody resets one.
 *
 * Nothing here sends mail or touches a database: the prisma surface is stubbed and the mailer is
 * resolved through a `ModuleRef` stub, so a failure is about the rule and never the environment.
 */

/**
 * A token issued JUST NOW, relative to the clock the test is running on.
 *
 * This was a hardcoded `2026-08-29T10:00:00Z`, which is a time bomb rather than a fixture: the TTL
 * is sixty minutes measured against the real clock, so the suite passed while the wall clock
 * happened to be within an hour of that instant and began failing when it was not. It was written
 * and it passed in the same hour, which is exactly how this kind of fault gets shipped.
 *
 * The expiry cases below pass their own `now` explicitly and do not depend on this.
 */
const issuedNow = (): Date => new Date();

function harness(opts: {
  user?: { id: number; name: string; email: string; username?: string; status: string } | null;
  row?: { email: string; token: string; created_at: Date | null } | null;
  mailer?: unknown;
} = {}) {
  const sent: { to: string; subject: string; html: string }[] = [];
  const upserts: Record<string, unknown>[] = [];
  const deletes: unknown[] = [];
  const updates: Record<string, unknown>[] = [];
  const endedSessions: number[] = [];

  const prisma = {
    users: {
      /*
       * Honours the OR the service builds, so "found by username" is really exercised rather than
       * assumed — a stub that returns the same row whatever it is asked would pass even if the
       * username branch had never been written.
       */
      findFirst: async (args?: {
        where?: { email?: { equals?: string }; OR?: { email?: { equals?: string }; username?: { equals?: string } }[] };
      }) => {
        const row = opts.user === undefined
          ? { id: 7, name: 'Aswini Kumar', email: 'aswini@example.test', username: 'Aswini', status: 'Active' }
          : opts.user;
        if (!row) return null;
        /*
         * EACH CONDITION IS MATCHED AGAINST ITS OWN COLUMN, which took two attempts to get right.
         *
         * Matching the value against email-or-username regardless of which the query named made the
         * username cases pass even against an EMAIL-ONLY lookup — the stub, not the code, was
         * satisfying them. Only running them against the old implementation exposed that, which is
         * the whole reason to do it.
         */
        const conds = args?.where?.OR ?? (args?.where?.email ? [{ email: args.where.email }] : []);
        if (!conds.length) return row;             // no identifier in the query: nothing to match on
        const eq = (a?: string | null, b?: string) =>
          !!a && !!b && a.toLowerCase() === b.toLowerCase();
        const r = row as { email?: string; username?: string };
        return conds.some((c) => eq(r.email, c.email?.equals) || eq(r.username, c.username?.equals))
          ? row
          : null;
      },
      update: async (a: Record<string, unknown>) => { updates.push(a); return a; },
    },
    password_reset_tokens: {
      findFirst: async () => opts.row ?? null,
      upsert: async (a: Record<string, unknown>) => { upserts.push(a); return a; },
      delete: async (a: unknown) => { deletes.push(a); return a; },
    },
  } as unknown as PrismaService;

  const mailer = opts.mailer ?? {
    sendDirect: async (to: string, subject: string, html: string) => { sent.push({ to, subject, html }); },
  };
  const moduleRef = { get: () => mailer } as never;

  // Cost 4: the same low bcrypt cost every other auth spec uses, so a suite is not spent hashing.
  const passwords = new PasswordHashService({ get: () => 4 } as never);
  const svc = new PasswordResetService(prisma, passwords, moduleRef);
  return { svc, sent, upserts, deletes, updates, endedSessions, endSessions: async (id: number) => { endedSessions.push(id); } };
}

// =================================================================================================

describe('the token itself', () => {
  it('is long, random, and different every time', () => {
    const a = PasswordResetService.newToken();
    const b = PasswordResetService.newToken();
    expect(a).toHaveLength(64);          // 32 bytes as hex
    expect(a).not.toBe(b);
  });

  it('is stored ONLY as a hash — the plaintext never reaches the table', async () => {
    const h = harness();
    await h.svc.request('aswini@example.test', 'https://crm.test');

    const stored = (h.upserts[0] as { create: { token: string } }).create.token;
    const link = h.sent[0].html.match(/token=([a-f0-9]+)/)![1];

    /*
     * The point of hashing it. Anyone reading a database copy sees this row and cannot turn it back
     * into a working link — the same reasoning as the password column beside it.
     */
    expect(stored).not.toBe(link);
    expect(stored).toBe(PasswordResetService.hash(link));
    expect(stored).toHaveLength(64);
  });

  it('matches its own hash and rejects anything else', () => {
    const token = PasswordResetService.newToken();
    expect(PasswordResetService.matches(token, PasswordResetService.hash(token))).toBe(true);
    expect(PasswordResetService.matches(token, PasswordResetService.hash('other'))).toBe(false);
    // A malformed or truncated hash must be refused, not throw — `timingSafeEqual` requires equal
    // lengths, so the length is checked first.
    expect(() => PasswordResetService.matches(token, 'short')).not.toThrow();
    expect(PasswordResetService.matches(token, 'short')).toBe(false);
  });

  it('expires an hour after it was issued', () => {
    const issued = new Date('2026-08-29T09:00:00Z');
    expect(PasswordResetService.isExpired(issued, new Date('2026-08-29T09:59:00Z'))).toBe(false);
    expect(PasswordResetService.isExpired(issued, new Date('2026-08-29T10:01:00Z'))).toBe(true);
    // A row with no timestamp cannot be shown to be fresh, so it is treated as stale.
    expect(PasswordResetService.isExpired(null)).toBe(true);
  });
});

describe('requesting a link tells nobody who exists', () => {
  // The wording widened with the lookup: the form now takes a username or an email, so the reply
  // can no longer promise anything about "that email address".
  const ANSWER = /If that account exists/i;

  it('answers the same for a real address', async () => {
    const h = harness();
    expect((await h.svc.request('aswini@example.test', 'https://crm.test')).message).toMatch(ANSWER);
    await h.svc.lastDelivery;                     // the send is deferred; see the service note
    expect(h.sent).toHaveLength(1);
  });

  it('answers the same for an address that does not exist — and sends nothing', async () => {
    const h = harness({ user: null });
    expect((await h.svc.request('nobody@example.test', 'https://crm.test')).message).toMatch(ANSWER);
    expect(h.sent).toEqual([]);
    expect(h.upserts).toEqual([]);
  });

  it('answers the same for a DISABLED account, and sends nothing', async () => {
    const h = harness({ user: { id: 9, name: 'Gone', email: 'gone@example.test', status: 'Inactive' } });
    expect((await h.svc.request('gone@example.test', 'https://crm.test')).message).toMatch(ANSWER);
    // A departed employee must not be able to let themselves back in.
    expect(h.sent).toEqual([]);
  });

  it('answers the same when the mail send FAILS', async () => {
    const h = harness({ mailer: { sendDirect: async () => { throw new Error('SMTP down'); } } });
    // "We could not email you" would confirm the address was real. It is logged instead.
    expect((await h.svc.request('aswini@example.test', 'https://crm.test')).message).toMatch(ANSWER);
    // And the deferred send must absorb its own failure rather than reject into nothing, which
    // would take the process down on a mail outage.
    await expect(h.svc.lastDelivery).resolves.toBeUndefined();
  });
});

describe('the email that is sent', () => {
  it('carries one link, to the reset page, with the token and address', async () => {
    const h = harness();
    await h.svc.request('aswini@example.test', 'https://crm.test/');
    await h.svc.lastDelivery;

    const { html, subject, to } = h.sent[0];
    expect(to).toBe('aswini@example.test');
    expect(subject).toMatch(/reset your password/i);
    expect(html).toContain('https://crm.test/reset-password?token=');
    expect(html).toContain('email=aswini%40example.test');
    // A trailing slash on the configured origin must not produce "//reset-password".
    expect(html).not.toContain('//reset-password');
  });

  it('greets the person and says what to do if it was not them', async () => {
    const h = harness();
    await h.svc.request('aswini@example.test', 'https://crm.test');
    await h.svc.lastDelivery;
    expect(h.sent[0].html).toContain('Hi Aswini,');
    expect(h.sent[0].html).toMatch(/was not you/i);
  });

  it('escapes the name rather than trusting it', async () => {
    const h = harness({ user: { id: 7, name: '<script>x</script>', email: 'a@example.test', status: 'Active' } });
    await h.svc.request('a@example.test', 'https://crm.test');
    await h.svc.lastDelivery;
    expect(h.sent[0].html).not.toContain('<script>');
  });
});

describe('spending the link', () => {
  const fresh = (token: string) => ({
    email: 'aswini@example.test', token: PasswordResetService.hash(token), created_at: issuedNow(),
  });

  it('sets the new password, spends the token, and ends every session', async () => {
    const token = PasswordResetService.newToken();
    const h = harness({ row: fresh(token) });

    const r = await h.svc.reset('aswini@example.test', token, 'a-new-password', 'a-new-password', h.endSessions);

    expect(r.message).toMatch(/has been reset/i);
    expect(h.updates).toHaveLength(1);
    expect(h.deletes).toHaveLength(1);                 // single use
    expect(h.endedSessions).toEqual([7]);              // the thief's session ends too
  });

  it('stores a HASH of the new password, never the password', async () => {
    const token = PasswordResetService.newToken();
    const h = harness({ row: fresh(token) });

    await h.svc.reset('aswini@example.test', token, 'a-new-password', 'a-new-password', h.endSessions);

    const written = (h.updates[0] as { data: { password: string } }).data.password;
    expect(written).not.toBe('a-new-password');
    expect(written.startsWith('$2')).toBe(true);       // bcrypt
  });

  it('refuses a wrong token', async () => {
    const h = harness({ row: fresh(PasswordResetService.newToken()) });
    await expect(h.svc.reset('aswini@example.test', PasswordResetService.newToken(), 'pw12345678', 'pw12345678', h.endSessions))
      .rejects.toThrow();
    expect(h.updates).toEqual([]);
  });

  it('refuses an EXPIRED token, and clears the dead row', async () => {
    const token = PasswordResetService.newToken();
    const stale = { email: 'aswini@example.test', token: PasswordResetService.hash(token), created_at: new Date('2026-01-01T00:00:00Z') };
    const h = harness({ row: stale });

    await expect(h.svc.reset('aswini@example.test', token, 'pw12345678', 'pw12345678', h.endSessions)).rejects.toThrow();
    expect(h.updates).toEqual([]);
    // An expired row is not a credential and should not linger in the table.
    expect(h.deletes).toHaveLength(1);
  });

  it('refuses when no reset was ever requested', async () => {
    const h = harness({ row: null });
    await expect(h.svc.reset('aswini@example.test', 'anything', 'pw12345678', 'pw12345678', h.endSessions)).rejects.toThrow();
  });

  it('refuses a mismatched confirmation', async () => {
    const token = PasswordResetService.newToken();
    const h = harness({ row: fresh(token) });
    await expect(h.svc.reset('aswini@example.test', token, 'one-password', 'another-password', h.endSessions)).rejects.toThrow();
    expect(h.updates).toEqual([]);
  });

  it('refuses a password past bcrypt\'s 72-byte limit', async () => {
    const token = PasswordResetService.newToken();
    const h = harness({ row: fresh(token) });
    const tooLong = 'x'.repeat(100);
    // Anything past 72 bytes is silently ignored when stored, so it would not really be part of it.
    await expect(h.svc.reset('aswini@example.test', token, tooLong, tooLong, h.endSessions)).rejects.toThrow();
  });

  it('refuses to reset a DISABLED account even with a valid token', async () => {
    const token = PasswordResetService.newToken();
    const h = harness({ row: fresh(token), user: { id: 9, name: 'Gone', email: 'aswini@example.test', status: 'Inactive' } });
    // The account could have been switched off between the link being issued and used.
    await expect(h.svc.reset('aswini@example.test', token, 'pw12345678', 'pw12345678', h.endSessions)).rejects.toThrow();
    expect(h.updates).toEqual([]);
  });

  it('gives ONE message for wrong, expired and never-issued alike', async () => {
    const msg = async (h: ReturnType<typeof harness>, token: string) =>
      h.svc.reset('aswini@example.test', token, 'pw12345678', 'pw12345678', h.endSessions)
        .then(() => null).catch((e: { response?: { errors?: { token?: string[] } } }) => e.response?.errors?.token?.[0]);

    const wrong = await msg(harness({ row: fresh(PasswordResetService.newToken()) }), PasswordResetService.newToken());
    const missing = await msg(harness({ row: null }), PasswordResetService.newToken());

    // Distinguishing them would let somebody probe which addresses have a reset pending.
    expect(wrong).toBe(missing);
    expect(wrong).toMatch(/invalid or has expired/i);
  });
});

describe('found by username as well as email', () => {
  /**
   * THE TRAP THIS CLOSES. Sign-in asks for a USERNAME; this form asked for an email; and on this
   * deployment they differ on most accounts — "Aswini" against "aswinikuna786@gmail.com". So the
   * natural thing to type matched nothing, and because the reply deliberately never reveals whether
   * an account exists, the page reported success and no mail was ever sent. Observed exactly that.
   */
  it('accepts the username somebody signs in with', async () => {
    const h = harness();
    await h.svc.request('Aswini', 'https://crm.test');

    expect(h.sent).toHaveLength(1);
    // The link goes to the address ON THE ACCOUNT, never to what was typed.
    expect(h.sent[0].to).toBe('aswini@example.test');
  });

  it('still accepts the email address', async () => {
    const h = harness();
    await h.svc.request('aswini@example.test', 'https://crm.test');
    expect(h.sent[0].to).toBe('aswini@example.test');
  });

  it('matches a username regardless of case, as the index does', async () => {
    const h = harness();
    await h.svc.request('ASWINI', 'https://crm.test');
    expect(h.sent).toHaveLength(1);
  });

  it('keys the token to the account email, not to what was typed', async () => {
    const h = harness();
    await h.svc.request('Aswini', 'https://crm.test');
    // `password_reset_tokens.email` is the primary key and the value `reset()` looks up by, so a
    // username stored here would be a link that could never be spent.
    expect((h.upserts[0] as { where: { email: string } }).where.email).toBe('aswini@example.test');
  });

  it('still says nothing when neither column matches', async () => {
    const h = harness();
    const r = await h.svc.request('nobody-at-all', 'https://crm.test');
    expect(r.message).toMatch(/If that account exists/i);
    expect(h.sent).toEqual([]);
  });
});

// =================================================================================================

/**
 * The stated rules for a reset email, each as an assertion.
 *
 * Most were already covered above and are not repeated here; this block closes the four that were
 * asserted nowhere - superseding an earlier link, keeping credentials out of the message, the
 * scheme of the link, and the TIMING half of not disclosing who has an account.
 */
describe('the security rules for the reset email', () => {
  it('supersedes any earlier link, because the row is keyed by the account email', async () => {
    /*
     * Two live links would mean an intercepted-but-unused first one still worked after the person
     * grew suspicious and asked for another. `email` is the table primary key and the write is an
     * upsert, so the second request OVERWRITES the first hash - the invalidation is structural
     * rather than a cleanup somebody has to remember.
     */
    const h = harness();
    await h.svc.request('aswini@example.test', 'https://crm.test');
    await h.svc.request('aswini@example.test', 'https://crm.test');

    const keys = h.upserts.map((u) => (u as { where: unknown }).where);
    expect(keys).toEqual([{ email: 'aswini@example.test' }, { email: 'aswini@example.test' }]);

    // A genuinely new secret each time, not the same token re-sent.
    const [first, second] = h.upserts.map((u) => (u as { update: { token: string } }).update.token);
    expect(first).not.toBe(second);
  });

  it('never carries a password, and does not even read the column', async () => {
    const h = harness();
    await h.svc.request('aswini@example.test', 'https://crm.test');
    await h.svc.lastDelivery;

    const html = h.sent[0].html;
    expect(html).not.toMatch(/\$2[aby]\$/);            // no bcrypt hash
    expect(html).not.toMatch(/your password is/i);

    /*
     * Asserted at the SOURCE as well, because the stub above would happily hand back a password
     * column that the real query never asks for. The select is the reason the rule cannot be broken
     * by a careless edit to the template: there is nothing in scope to interpolate.
     */
    const source = readFileSync(join(__dirname, 'password-reset.service.ts'), 'utf8');
    const select = source.slice(source.indexOf('async request('), source.indexOf('const link ='));
    expect(select).toMatch(/select: \{ id: true, name: true, email: true, status: true \}/);
    expect(select).not.toContain('password: true');
  });

  it('builds the link from the configured origin, so an https site yields an https link', async () => {
    // Production cannot boot with a non-https FRONTEND_URL - that is enforced and tested in
    // `config/validate-config.spec.ts`. Here: the link inherits the origin rather than rewriting it.
    const h = harness();
    await h.svc.request('aswini@example.test', 'https://crm.gethomehub.ca');
    await h.svc.lastDelivery;
    expect(h.sent[0].html).toContain('href="https://crm.gethomehub.ca/reset-password?token=');
  });

  it('answers before the email is sent, so a stopwatch cannot find real accounts', async () => {
    /*
     * THE MESSAGE BEING IDENTICAL IS NOT ENOUGH. While the reply waited for the SMTP round trip it
     * took 412ms for an account that exists and 0ms for one that does not - measured against a
     * 400ms send. Nothing was disclosed in words; the clock disclosed it instead, and an endpoint
     * anybody may call a million times is exactly where that matters.
     *
     * Held open rather than timed, so this test cannot go flaky on a loaded machine: if the answer
     * were still gated on delivery, it would hang here instead of failing on a threshold.
     */
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const h = harness({ mailer: { sendDirect: async () => { await blocked; } } });

    const answer = await h.svc.request('aswini@example.test', 'https://crm.test');
    expect(answer.message).toMatch(/If that account exists/i);
    expect(h.sent).toEqual([]);                       // genuinely still in flight

    release();
    await h.svc.lastDelivery;
  });
});
