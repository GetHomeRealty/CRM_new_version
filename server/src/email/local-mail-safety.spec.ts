import { PrismaClient } from '@prisma/client';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { MailerService } from './mailer.service';

/**
 * That THIS MACHINE cannot email a real person.
 *
 * WHAT WAS ALREADY COVERED, and why this file is not a duplicate. `mail-redirect.spec.ts` pins the
 * DECISION — what `redirectTarget()` returns for a given environment — and `mail-delivery-mode.spec.ts`
 * pins its APPLICATION, that the resolved address is the one actually put on the message. Both are
 * about the code, and both passed happily throughout the period this deployment was configured to
 * send real mail to real clients from a developer's laptop on a scheduler.
 *
 * Nothing asserted the CONFIGURATION. That is the gap: the logic being correct is worth nothing if
 * the two variables governing it are set to "send for real", which is exactly what `server/.env`
 * said. This file reads the file that actually governs this process and asserts the outcome.
 *
 * SKIPPED WHERE THERE IS NO `.env`. It is gitignored, so CI and a fresh clone have none — and a
 * test that fails on a machine with nothing to misconfigure would be noise rather than a guard.
 */

const ENV_PATH = join(__dirname, '..', '..', '.env');

/** Last occurrence wins, exactly as dotenv reads it — a duplicate key silently beats the first. */
function fromEnvFile(name: string): string | null {
  if (!existsSync(ENV_PATH)) return null;
  const lines = readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  let value: string | null = null;
  for (const line of lines) {
    // Anchored to the line start so the documentation block above these settings — which spells the
    // variable names out in prose — cannot be mistaken for an assignment.
    if (line.startsWith(`${name}=`)) value = line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return value;
}

const hasEnvFile = existsSync(ENV_PATH);
const describeLocal = hasEnvFile ? describe : describe.skip;

describeLocal('the local .env cannot send real mail', () => {
  it('does not allow real sending', () => {
    // `MAIL_ALLOW_REAL_SEND=1` on a developer machine is what let a scheduler email real clients
    // with nobody at the keyboard.
    const allow = (fromEnvFile('MAIL_ALLOW_REAL_SEND') ?? '').toLowerCase();
    expect(['1', 'true', 'yes', 'on']).not.toContain(allow);
  });

  it('redirects everything to a single designated mailbox', () => {
    // Necessary but not sufficient — the address itself is checked below.
    expect(fromEnvFile('MAIL_REDIRECT_TO') ?? '').not.toBe('');
  });

  it('sends only somewhere THIS BROKERAGE controls — unroutable, or a colleague', async () => {
    /*
     * THE ASSERTION THIS REPLACES WAS TOO WEAK, and it is worth saying why rather than quietly
     * improving it.
     *
     * It first asserted the target ended in `.invalid`. That pinned one particular CHOICE rather
     * than the rule, and broke the moment a readable capture mailbox was configured — so it was
     * relaxed to "non-empty". But "non-empty" would pass with `MAIL_REDIRECT_TO=a-client@example.com`:
     * every message replaced, all of them landing in a stranger's inbox. That is not the property
     * anybody wanted; it is merely the property that happened to survive the edit.
     *
     * The rule is that the target must be a mailbox SOMEBODY HERE CONTROLS: either an address that
     * can never resolve, or one belonging to a user account of this application. An arbitrary
     * outside address fails, which is the case the weakened version stopped catching.
     *
     * NOT "must not be a lead". The address in use is both a user and a lead — it is a colleague's
     * own Gmail, which is a perfectly reasonable place to capture test mail. Ownership is the
     * question, not whether the address appears elsewhere in the database.
     */
    const target = (fromEnvFile('MAIL_REDIRECT_TO') ?? '').trim().toLowerCase();
    if (target.endsWith('.invalid')) return;              // unroutable: nothing to check further

    const prisma = new PrismaClient();
    try {
      const owned = await prisma.users.count({ where: { email: { equals: target, mode: 'insensitive' } } });
      expect(owned).toBeGreaterThan(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('is not quietly overridden by a duplicate key later in the file', () => {
    /*
     * dotenv keeps the LAST occurrence. A second `MAIL_ALLOW_REAL_SEND=1` further down would beat
     * the safe one above it and nothing would report the conflict — which has happened in this file
     * before, and is recorded in it. Counting the assignments is what makes that visible.
     */
    const lines = readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
    for (const key of ['MAIL_ALLOW_REAL_SEND', 'MAIL_REDIRECT_TO']) {
      expect(lines.filter((l) => l.startsWith(`${key}=`))).toHaveLength(1);
    }
  });

  it('resolves, through the real code path, to the designated mailbox rather than the recipient', () => {
    const saved = { allow: process.env.MAIL_ALLOW_REAL_SEND, to: process.env.MAIL_REDIRECT_TO, env: process.env.NODE_ENV };
    try {
      // The file's values, put through the function the mailer actually consults.
      process.env.MAIL_ALLOW_REAL_SEND = fromEnvFile('MAIL_ALLOW_REAL_SEND') ?? '';
      process.env.MAIL_REDIRECT_TO = fromEnvFile('MAIL_REDIRECT_TO') ?? '';
      process.env.NODE_ENV = 'development';

      // Non-null is the whole guarantee: the recipient the application asked for is replaced.
      const target = MailerService.redirectTarget();
      expect(target).not.toBeNull();
      expect(String(target)).not.toBe('');
    } finally {
      process.env.MAIL_ALLOW_REAL_SEND = saved.allow ?? '';
      process.env.MAIL_REDIRECT_TO = saved.to ?? '';
      process.env.NODE_ENV = saved.env ?? 'test';
    }
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
    const outside = source.split('static redirectTarget()')[1].split('\n').slice(12).join('\n');
    expect(outside).not.toMatch(/process\.env\.MAIL_REDIRECT_TO/);
  });
});
