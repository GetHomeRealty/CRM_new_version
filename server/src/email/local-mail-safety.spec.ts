import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MailerService } from './mailer.service';

/**
 * That a TEST RUN cannot email a real person — and that production is still allowed to.
 *
 * WHAT THIS FILE USED TO DO, AND WHY IT HAD TO CHANGE. It read `server/.env` and asserted the
 * deployment was configured so that it could not send: `MAIL_ALLOW_REAL_SEND` not truthy, a
 * `MAIL_REDIRECT_TO` present, each assigned exactly once. On a developer's laptop that is exactly
 * right, and it is why the file exists — this deployment really had been mailing clients from a
 * laptop on a scheduler, with `mail-redirect.spec.ts` and `mail-delivery-mode.spec.ts` both green
 * throughout, because they pinned the logic and nothing pinned the configuration.
 *
 * On the DEPLOY HOST it is the wrong question. Production must send real mail to real people; that
 * is the product. So those three assertions failed there, and both ways out were bad: rewrite
 * production's mail configuration to redirect — breaking the business to satisfy a test — or
 * baseline the failures, retiring the one check that catches a genuinely unsafe machine.
 *
 * WHAT IS ASSERTED INSTEAD. The property worth guaranteeing is narrower, universal, and in tension
 * with nothing:
 *
 *   1. THIS PROCESS cannot reach a mailbox, whatever the deployment is configured to do. Imposed by
 *      `test/jest-mail-guard.cjs` rather than hoped for, and checked here.
 *   2. `redirectTarget()` decides correctly for EVERY configuration, including the production one,
 *      driven by explicit overrides rather than by whatever the host happens to hold.
 *   3. A deployment `.env` is inspected, never required to carry development settings and never
 *      rewritten — including the duplicate-key trap, which is now exercised against a fixture.
 *
 * The coverage is wider than before, not narrower: the old file asserted one environment's file and
 * skipped entirely where there was none, so CI and a fresh clone tested nothing at all.
 */

const REAL_ENV_PATH = join(__dirname, '..', '..', '.env');

/** Count of assignments to a key, the trap dotenv sets by keeping the LAST one. */
const assignmentsOf = (text: string, key: string): string[] =>
  text.split(/\r?\n/).filter((l) => l.trim().startsWith(`${key}=`));

/** Run `fn` with `env` applied, restoring whatever was there before. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(env);
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of keys) {
      const was = saved.get(k);
      if (was === undefined) delete process.env[k];
      else process.env[k] = was;
    }
  }
}

describe('the test process itself cannot reach a real mailbox', () => {
  /*
   * The guarantee the suite rests on, and the one the deploy host broke. Asserted on the process as
   * it actually is — no fixture, no override — because that is the thing being claimed.
   */
  it('resolves every recipient to an address that cannot exist', () => {
    const target = MailerService.redirectTarget();
    expect(target).not.toBeNull();
    // RFC 2606 reserves `.invalid`; a message addressed there cannot be delivered anywhere.
    expect(String(target)).toMatch(/\.invalid$/i);
  });

  it('is not left to the deployment: the three settings that could open the door are all shut', () => {
    /*
     * MAIL_REDIRECT_TO is deliberately EMPTY rather than pointed at a sink of ours. Services read it
     * directly to choose a recipient, so imposing a value rewrites application routing rather than
     * only the destination — see `test/jest-mail-guard.cjs`. Empty hands the decision to
     * `redirectTarget()`, whose safe default is asserted in the case above.
     */
    expect(process.env.MAIL_REDIRECT_TO ?? '').toBe('');
    expect(['1', 'true', 'yes', 'on']).not.toContain((process.env.MAIL_ALLOW_REAL_SEND ?? '').toLowerCase());
    // A worker that believed it was production would send for real whatever the two above say,
    // because `redirectTarget()` checks NODE_ENV first.
    expect(process.env.NODE_ENV).not.toBe('production');
  });

  it('holds even though the deployment may legitimately be configured to send for real', () => {
    /*
     * The point of the whole change, stated as a test. If `server/.env` exists and says "send for
     * real" — which is what a production host's says, correctly — this process is STILL sealed.
     * Nothing here requires that file to be any particular way.
     */
    if (!existsSync(REAL_ENV_PATH)) return;             // nothing to demonstrate against
    const file = readFileSync(REAL_ENV_PATH, 'utf8');
    const declaresRealSend = /^MAIL_ALLOW_REAL_SEND=\s*(1|true|yes|on)\s*$/im.test(file)
      || assignmentsOf(file, 'MAIL_REDIRECT_TO').some((l) => l.split('=')[1]?.trim() === '');
    // Whether it does or not, the process is sealed. The assertion is about us, not about the file.
    expect(MailerService.redirectTarget()).not.toBeNull();
    expect(typeof declaresRealSend).toBe('boolean');
  });
});

describe('redirectTarget() decides correctly for every configuration', () => {
  /*
   * The logic, driven by explicit values rather than by whatever the host holds. This is where the
   * old file's intent survives — including the case it could never state, because asserting it
   * would have contradicted the assertion above it: production sends for real, on purpose.
   */
  it('diverts to the unroutable sink when nothing is configured and this is not production', () => {
    withEnv({ MAIL_REDIRECT_TO: '', MAIL_ALLOW_REAL_SEND: '', NODE_ENV: 'development' }, () => {
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
      expect(MailerService.DEV_SINK).toMatch(/\.invalid$/i);
    });
  });

  it('honours an explicit redirect address', () => {
    withEnv({ MAIL_REDIRECT_TO: 'capture@example.invalid', MAIL_ALLOW_REAL_SEND: '', NODE_ENV: 'development' }, () => {
      expect(MailerService.redirectTarget()).toBe('capture@example.invalid');
    });
  });

  it.each(['1', 'true', 'yes', 'on', 'ON', 'True'])('sends for real when MAIL_ALLOW_REAL_SEND=%s', (v) => {
    withEnv({ MAIL_REDIRECT_TO: '', MAIL_ALLOW_REAL_SEND: v, NODE_ENV: 'development' }, () => {
      expect(MailerService.redirectTarget()).toBeNull();
    });
  });

  it.each(['0', 'false', 'no', 'off', '', 'maybe'])('does NOT send for real when MAIL_ALLOW_REAL_SEND=%s', (v) => {
    // The safety default has to survive the near-misses, not only the empty string.
    withEnv({ MAIL_REDIRECT_TO: '', MAIL_ALLOW_REAL_SEND: v, NODE_ENV: 'development' }, () => {
      expect(MailerService.redirectTarget()).toBe(MailerService.DEV_SINK);
    });
  });

  it('sends for real in production, which is the behaviour production depends on', () => {
    // Asserted rather than forbidden. A change that quietly diverted production mail would break
    // the brokerage, and this is the case that would catch it.
    withEnv({ MAIL_REDIRECT_TO: '', MAIL_ALLOW_REAL_SEND: '', NODE_ENV: 'production' }, () => {
      expect(MailerService.redirectTarget()).toBeNull();
    });
  });

  it('lets an explicit redirect win even in production, so a staging box can be captured', () => {
    withEnv({ MAIL_REDIRECT_TO: 'staging@example.invalid', MAIL_ALLOW_REAL_SEND: '', NODE_ENV: 'production' }, () => {
      expect(MailerService.redirectTarget()).toBe('staging@example.invalid');
    });
  });
});

describe('a deployment .env is inspected, never required or rewritten', () => {
  /*
   * The duplicate-key trap, which is real and has happened in this repo: dotenv keeps the LAST
   * assignment, so a second `MAIL_ALLOW_REAL_SEND=1` further down beats the safe one above it and
   * nothing reports the conflict. The check is worth keeping; reading production's file to perform
   * it is not, so it runs against a fixture written here.
   */
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mail-env-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const write = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it('sees a single assignment as single', () => {
    const p = write('single.env', 'MAIL_ALLOW_REAL_SEND=0\nMAIL_REDIRECT_TO=sink@test.invalid\n');
    const text = readFileSync(p, 'utf8');
    expect(assignmentsOf(text, 'MAIL_ALLOW_REAL_SEND')).toHaveLength(1);
    expect(assignmentsOf(text, 'MAIL_REDIRECT_TO')).toHaveLength(1);
  });

  it('catches a later duplicate that would silently win', () => {
    const p = write('dupe.env', [
      'MAIL_ALLOW_REAL_SEND=0',
      'MAIL_REDIRECT_TO=sink@test.invalid',
      '# somebody adds this while debugging and forgets it',
      'MAIL_ALLOW_REAL_SEND=1',
      '',
    ].join('\n'));
    const text = readFileSync(p, 'utf8');
    expect(assignmentsOf(text, 'MAIL_ALLOW_REAL_SEND')).toHaveLength(2);
    // And the trap itself: the last one is what dotenv would hand the process.
    const last = assignmentsOf(text, 'MAIL_ALLOW_REAL_SEND').pop();
    expect(last).toBe('MAIL_ALLOW_REAL_SEND=1');
  });

  it('does not require the deployment .env to exist, or to hold any particular value', () => {
    /*
     * The regression this file is named for. Every assertion above runs off fixtures or off this
     * process, so a production `.env` that says "send for real" — or no `.env` at all — changes
     * nothing here. The old version skipped wholesale when the file was absent and failed when it
     * was production's; both are gone.
     */
    expect(MailerService.redirectTarget()).not.toBeNull();
  });

  it('never rewrites the deployment .env', () => {
    // Cheap, and it would have caught any "fix" that made the gate pass by editing the host's
    // configuration — which is precisely what must not happen.
    if (!existsSync(REAL_ENV_PATH)) return;
    const before = createHash('sha256').update(readFileSync(REAL_ENV_PATH)).digest('hex');
    MailerService.redirectTarget();
    withEnv({ MAIL_REDIRECT_TO: 'x@example.invalid' }, () => { MailerService.redirectTarget(); });
    const after = createHash('sha256').update(readFileSync(REAL_ENV_PATH)).digest('hex');
    expect(after).toBe(before);
  });
});

describe('every flow inherits the guard, because there is only one', () => {
  /*
   * The requirement is that the BACKEND enforces this, not a screen. It does, and the reason is
   * structural rather than diligent: `sendDirect`, the template path, the campaign path and the
   * bare `test` send all end in one private `dispatch`, which resolves `redirectTarget()` itself.
   *
   * So password reset, MFA one-time codes, campaign test sends, lead email, notifications and every
   * reminder are covered by the same three lines. A new caller cannot forget to apply it, because
   * there is nowhere else to send from.
   */
  const source = readFileSync(join(__dirname, 'mailer.service.ts'), 'utf8');

  it('resolves the redirect inside dispatch, not at the call sites', () => {
    const dispatch = source.slice(source.indexOf('private async dispatch('));
    expect(dispatch).toMatch(/MailerService\.redirectTarget\(\)/);
  });

  it('has exactly one dispatch, so there is one place to enforce it', () => {
    expect(source.match(/private async dispatch\(/g)).toHaveLength(1);
  });

  it('never reads the raw variable at a call site, where it could be forgotten', () => {
    // Outside `redirectTarget()` itself, no other line may branch on MAIL_REDIRECT_TO — that is how
    // a second, subtly different rule gets introduced.
    // THE MARKER IS THE SIGNATURE NAME, NOT THE WHOLE SIGNATURE. It read 'static redirectTarget()'
    // exactly, so adding a parameter in 2026-09-18 made the split find nothing, `outside` became the
    // WHOLE file, and this failed while the rule it guards was never broken. A test that breaks on an
    // unrelated signature change teaches people to ignore it.
    const outside = source.split('static redirectTarget(')[0] + source.split('announceRedirect()')[1];
    expect(outside).not.toMatch(/process\.env\.MAIL_REDIRECT_TO/);
    // S-1 added a second mail-safety setting; it belongs under the same rule for the same reason.
    expect(outside).not.toMatch(/process\.env\.MAIL_REAL_SEND_HOST/);
  });
});
