import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MailAccountService } from './mail-account.service';
import { MailerService } from './mailer.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';

/**
 * The mailbox a CRM message leaves from, once the brokerage has chosen one.
 *
 * WHAT WAS REPORTED. Clients received mail from a colleague's address — "sent through Veena".
 * Nobody chose that. Every mail account in this system belongs to a PERSON, so the brokerage
 * lookups in `defaultSender` all missed, and the resolution fell through to "somebody's personal
 * account", taken in id order. Which colleague that was is an accident of which row sorted first.
 *
 * WHY PRESSING "SET AS PRIMARY" COULD NOT FIX IT. `is_default` is stored per user per area, so a
 * dozen rows can each be "the default" — each for its own owner. `setDefault` calls
 * `makeSoleDefault(id, account.user_id, scope)`, which clears only the defaults of that same owner.
 * Choosing a personally-owned account as primary was therefore never brokerage-wide, however many
 * times it was pressed.
 *
 * THE RULE THESE PIN. An account with NO owner, marked default, is unambiguous: one per area, set
 * from the admin screen. When one exists it is the answer for everybody in that area. When none
 * exists nothing changes at all — which is the point of doing it this way rather than refusing:
 * a brokerage that has connected no shared mailbox still needs its mail to go out.
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

const crypt = new LaravelCryptService({ get: () => process.env.APP_KEY } as never);
const svc = (tx: PrismaService) => new MailAccountService(tx, crypt as never);
const tag = () => { seq += 1; return `${Date.now()}-${seq}`; };

/** Start from a blank slate: this database's own accounts would otherwise answer every lookup. */
async function emptyAccounts(tx: PrismaService) {
  await tx.mail_accounts.updateMany({ where: { is_active: true }, data: { is_active: false } });
}

async function makeUser(tx: PrismaService) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `ZZ Sender ${t}`, email: `zz-primary-${t}@x.test`, password: 'x',
      role: 'agent', status: 'Active', created_at: now, updated_at: now,
    },
  });
}

async function account(tx: PrismaService, over: Record<string, unknown>) {
  const now = new Date();
  const t = tag();
  return tx.mail_accounts.create({
    data: {
      name: `ZZ ${t}`, from_email: `zz-${t}@x.test`, username: `zz-${t}@x.test`,
      host: 'smtp.example.test', port: 587, encryption: 'tls', password: crypt.encryptString('x'),
      is_active: true, is_default: false, created_at: now, updated_at: now,
      ...over,
    },
  });
}

describe('a brokerage primary, once chosen', () => {
  it('is used instead of the sender’s own mailbox', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const theirs = await account(tx, { user_id: user.id, scope: 'crm', is_default: true });
      const primary = await account(tx, { user_id: null, scope: 'crm', is_default: true });

      const chosen = await svc(tx).senderFor(user.id, 'crm');

      // THE REPORT: this returned a person's mailbox, and the recipient saw their name.
      expect(chosen?.id).toBe(primary.id);
      expect(chosen?.id).not.toBe(theirs.id);
    });
  });

  it('is used for a send with no particular person behind it', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const primary = await account(tx, { user_id: null, scope: 'crm', is_default: true });
      expect((await svc(tx).senderFor(null, 'crm'))?.id).toBe(primary.id);
    });
  });

  it('belongs to its own area — a CRM primary does not take over the Desk', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      await account(tx, { user_id: null, scope: 'crm', is_default: true });
      const deskOwn = await account(tx, { user_id: user.id, scope: 'desk', is_default: true });

      expect((await svc(tx).senderFor(user.id, 'desk'))?.id).toBe(deskOwn.id);
    });
  });
});

describe('what does NOT count as the brokerage’s choice', () => {
  it('a shared account that was never marked primary does not override', async () => {
    // Otherwise merely connecting a second shared mailbox would silently move everyone onto it.
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const theirs = await account(tx, { user_id: user.id, scope: 'crm', is_default: true });
      await account(tx, { user_id: null, scope: 'crm', is_default: false });

      expect((await svc(tx).senderFor(user.id, 'crm'))?.id).toBe(theirs.id);
    });
  });

  it('a switched-off primary does not override', async () => {
    // An inactive primary would be chosen and then fail on every send.
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const theirs = await account(tx, { user_id: user.id, scope: 'crm', is_default: true });
      await account(tx, { user_id: null, scope: 'crm', is_default: true, is_active: false });

      expect((await svc(tx).senderFor(user.id, 'crm'))?.id).toBe(theirs.id);
    });
  });

  it('with no primary set, nothing changes — the sender’s own mailbox still wins', async () => {
    /*
     * The safety property. Until somebody chooses a primary this whole change is inert, so a
     * brokerage that has connected no shared mailbox keeps sending exactly as it does today.
     */
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const theirs = await account(tx, { user_id: user.id, scope: 'crm', is_default: true });

      expect((await svc(tx).senderFor(user.id, 'crm'))?.id).toBe(theirs.id);
    });
  });
});

describe('a primary set through the admin screen carries no area', () => {
  /*
   * THE CASE THAT MATTERS IN PRACTICE, and the one an area-only lookup would miss.
   *
   * Since the 2026-09-04 Hub change, `storeForUser` stamps every new account `scope: null`. So the
   * mailbox an admin connects and marks primary has no area on it at all. If `senderFor` matched
   * only on `scope`, this feature would work when the row was promoted by hand-written SQL and never
   * when it was set through the screen — which is the only way anyone will actually set it.
   */
  it('is the sender even though it is marked for no area', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const theirs = await account(tx, { user_id: user.id, scope: null, is_default: true });
      const primary = await account(tx, { user_id: null, scope: null, is_default: true });

      const chosen = await svc(tx).senderFor(user.id, 'crm');
      expect(chosen?.id).toBe(primary.id);
      expect(chosen?.id).not.toBe(theirs.id);
    });
  });

  it('the area’s own primary still wins where a brokerage has both', async () => {
    // Mirrors `defaultSender`'s order: the area's shared account, then any shared account.
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const forCrm = await account(tx, { user_id: null, scope: 'crm', is_default: true });
      const forAnything = await account(tx, { user_id: null, scope: null, is_default: true });

      expect((await svc(tx).senderFor(null, 'crm'))?.id).toBe(forCrm.id);
      expect((await svc(tx).senderFor(null, 'desk'))?.id).toBe(forAnything.id);
    });
  });
});

describe('the side a mailbox is marked for does not decide who sends from it', () => {
  /*
   * THE BROKERAGE'S RULING OF 2026-09-12, restated here so this file cannot be read as disagreeing
   * with it — see the header of `campaign-sender-area.spec.ts`.
   *
   * I ADDED A `scope` FILTER TO BOTH OWN-ACCOUNT LOOKUPS AND WAS WRONG TO. The comment above
   * `senderFor` says "your own account in this area", so the missing filter read as a bug. It is
   * not: the same filter stood here uncommitted until 2026-09-12, when its author removed it, and
   * the brokerage settled the question that day in favour of one mailbox used on both sides. The
   * filter also could not work — mailboxes connected since 2026-09-04 carry `scope: null`, so
   * filtering on the area would match none of them and put those people back on the brokerage's
   * address instead of their own. That is the failure these two tests exist to catch.
   */
  it('a mailbox marked for the Desk still sends a CRM message', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const desk = await account(tx, { user_id: user.id, scope: 'desk', is_default: true });

      expect((await svc(tx).senderFor(user.id, 'crm'))?.id).toBe(desk.id);
    });
  });

  it('a mailbox marked for no area at all still sends on both sides', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const mine = await account(tx, { user_id: user.id, scope: null, is_default: true });

      expect((await svc(tx).senderFor(user.id, 'crm'))?.id).toBe(mine.id);
      expect((await svc(tx).senderFor(user.id, 'desk'))?.id).toBe(mine.id);
    });
  });
});

describe('the other send path: resolveSender, which the lead composer reaches', () => {
  /*
   * TWO RESOLVERS, AND FIXING ONE WOULD HAVE LOOKED LIKE FIXING THE PROBLEM. Campaigns and the CRM's
   * own mail go through `senderFor`, tested above. `LeadActivityService.sendEmail` — an agent writing
   * to a lead, which is the most ordinary client-facing email in the CRM — goes through
   * `MailerService.resolveSender` instead, where the brokerage's shared default sat AFTER the
   * sender's own mailbox and so lost to every agent who had connected anything.
   *
   * NOTHING IS SENT BY THESE TESTS. Only the resolution is exercised.
   */
  const mailer = (tx: PrismaService) => new MailerService(tx, crypt, new MailAccountService(tx, crypt as never));

  it('sends from the brokerage primary when the composer picked no account', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const theirs = await account(tx, { user_id: user.id, is_default: true });
      const primary = await account(tx, { user_id: null, is_default: true });

      const chosen = await mailer(tx).resolveSender(null, user.id);
      expect(chosen.id).toBe(primary.id);
      expect(chosen.id).not.toBe(theirs.id);
    });
  });

  it('still honours an account the composer named explicitly', async () => {
    /*
     * The limit of the rule, and it is deliberate. A named `account_id` is a per-message instruction
     * from the person sending — the composer's picker, or an onboarding template naming its own
     * mailbox. A primary supplies a missing choice; it does not overrule one that was made.
     */
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const theirs = await account(tx, { user_id: user.id, is_default: true });
      await account(tx, { user_id: null, is_default: true });

      expect((await mailer(tx).resolveSender(theirs.id, user.id)).id).toBe(theirs.id);
    });
  });

  it('with no primary set, the sender’s own mailbox still wins here too', async () => {
    // The same inertness property as above, on this path: nothing changes until a primary exists.
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const theirs = await account(tx, { user_id: user.id, is_default: true });

      expect((await mailer(tx).resolveSender(null, user.id)).id).toBe(theirs.id);
    });
  });

  it('a system send with no user behind it also uses the primary', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const primary = await account(tx, { user_id: null, is_default: true });
      expect((await mailer(tx).resolveSender(null, null)).id).toBe(primary.id);
    });
  });
});
