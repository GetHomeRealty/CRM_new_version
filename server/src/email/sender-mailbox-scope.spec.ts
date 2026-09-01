import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MailerService } from './mailer.service';
import { MailboxService } from '../inbox/mailbox.service';

/**
 * Which mailbox a message actually leaves from.
 *
 * THE DEFECT. `resolveSender` looked up an explicitly chosen account as
 * `{ id: accountId, is_active: true }` — no owner — and trusted every caller to have checked.
 * `LeadActivityService.sendEmail` did not: it confirmed `account_id` was a positive integer and
 * passed it straight through. So an agent could name a COLLEAGUE'S mailbox id in an ordinary
 * request body and the message went out from that colleague's address, authenticated with that
 * colleague's OAuth token, and was logged against it. Nothing had to be forged.
 *
 * WHAT MAKES IT WORSE HERE. This deployment has SEVEN mail accounts and NOT ONE brokerage account
 * (`user_id = null`), so every id in the table belongs to a real person. There was no shared
 * mailbox for the fallback to land on and nothing benign to pick by accident.
 *
 * The tests below cover the seven properties the sending path has to hold, and the token one
 * matters most: credentials are read off the account this resolves to, so resolving the wrong
 * account is the same thing as sending with the wrong credentials.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/** Nothing here opens a connection — only the account CHOICE is under test. */
const mailer = (tx: PrismaService) => new MailerService(
  tx,
  { encryptString: (v: string) => v, decryptString: (v: string) => v } as never,
  // `MailAccountService` is not consulted by `resolveSender`; passed inert so the constructor is
  // satisfied without standing up a dependency this file does not exercise.
  {} as never,
);
const mailbox = (tx: PrismaService) => new MailboxService(tx, { sendDirect: async () => undefined } as never);

async function makeUser(tx: PrismaService) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: { name: `Send ${t}`, email: `send-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
}

async function makeAccount(
  tx: PrismaService,
  userId: number | null,
  over: { is_default?: boolean; is_active?: boolean; scope?: string | null; token?: string } = {},
) {
  const now = new Date();
  const t = tag();
  return tx.mail_accounts.create({
    data: {
      name: `MB ${t}`, from_email: `mb-${t}@example.test`, username: `mb-${t}@example.test`,
      host: 'smtp.example.test', port: 587, encryption: over.token ? 'oauth' : 'tls',
      password: over.token ?? 'pw',
      user_id: userId, scope: over.scope === undefined ? 'crm' : over.scope,
      is_default: over.is_default ?? false,
      is_active: over.is_active ?? true,
      created_at: now, updated_at: now,
    },
  });
}

// =================================================================================================

describe('1 & 2. the primary mailbox is chosen on its own', () => {
  it('picks the active primary when nothing is specified', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeAccount(tx, u.id, { is_default: false });
      const primary = await makeAccount(tx, u.id, { is_default: true });

      expect((await mailer(tx).resolveSender(null, u.id)).id).toBe(primary.id);
      // The Inbox composer resolves the same way, so what you read and what you send from agree.
      expect((await mailbox(tx).sendingAccount(u.id, 'crm')).id).toBe(primary.id);
    });
  });
});

describe('3. an explicit choice overrides the primary — but only among your own', () => {
  it('honours another of YOUR mailboxes', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeAccount(tx, u.id, { is_default: true });
      const second = await makeAccount(tx, u.id);

      expect((await mailer(tx).resolveSender(second.id, u.id)).id).toBe(second.id);
    });
  });

  it('THE DEFECT: refuses a COLLEAGUE\'S mailbox and falls back to your own primary', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const them = await makeUser(tx);
      const mine = await makeAccount(tx, me.id, { is_default: true });
      const theirs = await makeAccount(tx, them.id, { is_default: true });

      const used = await mailer(tx).resolveSender(theirs.id, me.id);

      // Before the fix this returned `theirs` — their address, their credentials, their name on it.
      expect(used.id).not.toBe(theirs.id);
      expect(used.id).toBe(mine.id);
      expect(used.user_id).toBe(me.id);
    });
  });

  it('still allows the shared brokerage mailbox, which everybody may send through', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeAccount(tx, u.id, { is_default: true });
      const shared = await makeAccount(tx, null, { scope: null });

      expect((await mailer(tx).resolveSender(shared.id, u.id)).id).toBe(shared.id);
    });
  });

  it('honours a named account for a SYSTEM send, where there is no user to check against', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const acc = await makeAccount(tx, u.id, { is_default: true });

      // Onboarding templates name their own `mail_account_id` and pass no user. Unchanged.
      expect((await mailer(tx).resolveSender(acc.id, null)).id).toBe(acc.id);
    });
  });
});

describe('5. a disabled primary is not used', () => {
  it('skips a switched-off primary and uses an active mailbox instead', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeAccount(tx, u.id, { is_default: true, is_active: false });
      const live = await makeAccount(tx, u.id, { is_default: false, is_active: true });

      expect((await mailer(tx).resolveSender(null, u.id)).id).toBe(live.id);
      expect((await mailbox(tx).sendingAccount(u.id, 'crm')).id).toBe(live.id);
    });
  });

  it('will not send through a disabled mailbox even when it is named explicitly', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const off = await makeAccount(tx, u.id, { is_active: false });
      const on = await makeAccount(tx, u.id, { is_default: true });

      expect((await mailer(tx).resolveSender(off.id, u.id)).id).toBe(on.id);
    });
  });

  it('the Inbox composer refuses outright rather than borrowing somebody else\'s', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeAccount(tx, u.id, { is_default: true, is_active: false });
      // Another user has a perfectly good mailbox — it must not be reached for.
      const other = await makeUser(tx);
      await makeAccount(tx, other.id, { is_default: true });

      await expect(mailbox(tx).sendingAccount(u.id, 'crm')).rejects.toThrow(/No mailbox is connected/i);
    });
  });
});

describe('6. the credentials belong to the mailbox that was resolved', () => {
  it('returns the chosen account\'s own stored token, not another\'s', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const them = await makeUser(tx);
      const mine = await makeAccount(tx, me.id, { is_default: true, token: 'MY-REFRESH-TOKEN' });
      await makeAccount(tx, them.id, { is_default: true, token: 'THEIR-REFRESH-TOKEN' });

      const used = await mailer(tx).resolveSender(null, me.id);

      /*
       * The credential is read off whatever this returns, so "the right account" and "the right
       * token" are one question. Asserted on the stored value rather than trusting the id.
       */
      expect(used.id).toBe(mine.id);
      expect(used.password).toBe('MY-REFRESH-TOKEN');
      expect(used.from_email).toBe(mine.from_email);
    });
  });

  it('a rejected choice does not carry the rejected mailbox\'s token', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const them = await makeUser(tx);
      const mine = await makeAccount(tx, me.id, { is_default: true, token: 'MY-REFRESH-TOKEN' });
      const theirs = await makeAccount(tx, them.id, { is_default: true, token: 'THEIR-REFRESH-TOKEN' });

      const used = await mailer(tx).resolveSender(theirs.id, me.id);

      expect(used.password).toBe('MY-REFRESH-TOKEN');
      expect(used.password).not.toBe('THEIR-REFRESH-TOKEN');
      expect(used.id).toBe(mine.id);
    });
  });
});

describe('7. what must keep working', () => {
  it('a user with no mailbox of their own still resolves the brokerage one', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const shared = await makeAccount(tx, null, { scope: null, is_default: true });

      expect((await mailer(tx).resolveSender(null, u.id)).id).toBe(shared.id);
    });
  });

  it('borrows another user mailbox only as a LAST resort, and says so', async () => {
    await inRollback(async (tx) => {
      const stranded = await makeUser(tx);          // no mailbox of their own
      const colleague = await makeUser(tx);
      await makeAccount(tx, colleague.id, { is_default: true });

      const warned: string[] = [];
      const svc = mailer(tx);
      (svc as unknown as { log: { warn: (m: string) => void } }).log = { warn: (m) => warned.push(m) };

      const used = await svc.resolveSender(null, stranded.id);

      /*
       * WHICH account is deliberately not asserted. The last resort is an unordered `findFirst`
       * over the WHOLE table, so on a shared database it returns whichever personal mailbox the
       * database offers first — during development that was a real one belonging to a colleague,
       * which is the defect illustrating itself. The property that matters is that it is somebody
       * else's and that it no longer happens quietly.
       *
       * BEHAVIOUR DELIBERATELY UNCHANGED. 77 of 79 active users here have no mailbox and there is
       * no brokerage account, so refusing would stop nearly all of the brokerage's mail.
       */
      expect(used.user_id).not.toBe(stranded.id);
      expect(used.is_active).toBe(true);
      expect(warned.join(' ')).toMatch(/ANOTHER USER'S mailbox/i);
    });
  });

  it('does NOT warn when the brokerage mailbox is the one used', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const shared = await makeAccount(tx, null, { scope: null, is_default: true });

      const warned: string[] = [];
      const svc = mailer(tx);
      (svc as unknown as { log: { warn: (m: string) => void } }).log = { warn: (m) => warned.push(m) };

      // The shared account is a legitimate sender for everyone — nothing to report.
      expect((await svc.resolveSender(null, u.id)).id).toBe(shared.id);
      expect(warned).toEqual([]);
    });
  });

  it('a system send with neither account nor user still resolves something', async () => {
    await inRollback(async (tx) => {
      await makeAccount(tx, null, { scope: null, is_default: true });

      // OTP, notifications and reminders all call `sendDirect(to, subject, html)` with no account
      // and no user. That path must keep resolving, or every system email stops.
      await expect(mailer(tx).resolveSender(null, null)).resolves.toBeTruthy();
    });
  });
});
