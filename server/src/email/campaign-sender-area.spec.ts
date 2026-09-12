import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MailerService } from './mailer.service';
import { MailAccountService } from './mail-account.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';

/**
 * WHICH MAILBOX A SEND LEAVES FROM - the person's own, on either side.
 *
 * RULED BY THE BROKERAGE 2026-09-12, AND THREE OF THESE TESTS WERE REWRITTEN TO IT. A mailbox is
 * connected once and used from both the CRM and the Transaction Desk: the side a mailbox is marked
 * for no longer decides who sends from it. The owner chose this over the older per-area rule because
 * every mailbox connected since the 2026-09-04 change carries no side at all, so the per-area rule
 * left those people sending from the system's default address rather than from their own.
 *
 * WHAT THIS REPLACED, AND WHY THAT RULE EXISTED. CRM Account Settings said no CRM email account was
 * connected - and stated that each area keeps its own accounts - while a CRM campaign went out from
 * the agent's TRANSACTION DESK mailbox. `MailAccountService.senderFor` was written to close that
 * gap; campaigns reached the mailbox through `MailerService.resolveSender`, which never looked at
 * `scope`. The 2026-09-04 change then made personal mailboxes Hub-wide. A per-area filter ran on
 * this server uncommitted until 2026-09-12, when its author removed it, and the brokerage settled
 * the question the same day in favour of one mailbox used on both sides.
 *
 * WHAT DID NOT CHANGE, AND WHAT THE FALLBACKS ACTUALLY DO. With no mailbox of their own a person
 * falls back to the brokerage's shared account, and then - a gap recorded below and deliberately not
 * closed - to a colleague's. The colleague fallback still reads the side a mailbox is marked for, so
 * a CRM send will not borrow a colleague's Desk mailbox. The shared-account fallback does NOT:
 * `defaultSender` looks for a shared row in the area first, but its next two lookups drop `scope`, so
 * a shared row marked for the other side is used when the area has none. The person's own mailbox
 * ignores the mark outright. A switched-off mailbox is never used, and where nothing usable is
 * switched on the refusal still names the area, so the message says what to connect. Those two
 * refusals are tests five and seven below.
 *
 * NOTHING IS SENT BY THESE TESTS. Only the resolution is exercised.
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
const mailer = (tx: PrismaService) => new MailerService(tx, crypt, new MailAccountService(tx, crypt as never));

const tag = () => { seq += 1; return `${Date.now()}-${seq}`; };

/** Clear the shared pool so "which mailbox is chosen" is a question about this test's rows. */
async function emptyAccounts(tx: PrismaService) {
  await tx.mail_accounts.updateMany({ where: { is_active: true }, data: { is_active: false } });
}

async function makeUser(tx: PrismaService) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `ZZ Sender ${t}`, email: `zz-sender-${t}@x.test`, password: 'x',
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

describe('which mailbox a CRM campaign sends from', () => {
  it('uses the main mailbox of the person sending, whichever side it is marked for', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      // The other mailbox is created FIRST, so being the oldest cannot explain the answer: what is
      // being proved is that the mailbox marked as this person's main one wins.
      const other = await account(tx, { user_id: user.id, scope: 'crm' });
      const main = await account(tx, { user_id: user.id, scope: 'desk', is_default: true });

      const chosen = await mailer(tx).resolveSenderInArea(user.id, 'crm');

      // The 2026-09-12 ruling: connected once, used on both sides. The mark on a mailbox no longer
      // decides; the person's own main mailbox does, and this send leaves from it.
      expect(chosen.id).toBe(main.id);
      expect(chosen.id).not.toBe(other.id);
    });
  });

  it('uses the only mailbox a person has, even when it is marked for the other side', async () => {
    /*
     * The behaviour the brokerage chose on 2026-09-12, stated plainly: a CRM send by somebody whose
     * only mailbox is marked Transaction Desk leaves from that mailbox rather than stopping. That
     * mailbox carries no main-mailbox mark either, so this is also the fallback branch - the same
     * no-main-mailbox shape that branch serves. The refusal still happens where nothing usable
     * is switched on: the switched-off case and the nothing-connected case, tests five and seven.
     */
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const only = await account(tx, { user_id: user.id, scope: 'desk' });

      const chosen = await mailer(tx).resolveSenderInArea(user.id, 'crm');
      expect(chosen.id).toBe(only.id);
    });
  });

  it('STILL falls through to a colleague’s CRM mailbox — a gap this fix does NOT close', async () => {
    /*
     * ASSERTED AS IT IS, not as it ought to be. `senderFor` ends at `defaultSender(scope)`, whose
     * documented last resort is "somebody's personal account in this area, because having no sender
     * at all is worse than an unexpected one". So within the CRM area a campaign can still leave
     * from a colleague's address.
     *
     * That is a SEPARATE decision from the one this change made. Closing the cross-AREA hole is
     * unambiguous - CRM Account Settings already promises it. Closing the cross-PERSON one changes
     * a deliberate fallback that brokerage-wide announcements also rely on, and would stop sends
     * that work today. It is recorded here so the behaviour is visible rather than assumed, and so
     * the day somebody decides to close it, this test says exactly what changes.
     */
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const me = await makeUser(tx);
      const colleague = await makeUser(tx);
      const theirs = await account(tx, { user_id: colleague.id, scope: 'crm', is_default: true });

      const chosen = await mailer(tx).resolveSenderInArea(me.id, 'crm');
      expect(chosen.id).toBe(theirs.id);
    });
  });

  it('falls back to the brokerage’s own CRM mailbox, which everyone may use', async () => {
    // A shared account (`user_id = null`) is the brokerage's, not a colleague's, and is the
    // documented fallback. Refusing that would stop legitimate sends.
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const shared = await account(tx, { user_id: null, scope: 'crm', is_default: true });

      const chosen = await mailer(tx).resolveSenderInArea(user.id, 'crm');
      expect(chosen.id).toBe(shared.id);
    });
  });

  it('will not use a switched-off CRM mailbox', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      await account(tx, { user_id: user.id, scope: 'crm', is_active: false });

      await expect(mailer(tx).resolveSenderInArea(user.id, 'crm')).rejects.toThrow(/No active CRM/i);
    });
  });

  it('the Transaction Desk gives the same answer: the main mailbox of the person sending', async () => {
    // The rule is symmetrical: neither side reads the mark on a mailbox any more. The other mailbox
    // is created first here too, so age cannot explain the answer.
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const other = await account(tx, { user_id: user.id, scope: 'desk' });
      const main = await account(tx, { user_id: user.id, scope: 'crm', is_default: true });

      const chosen = await mailer(tx).resolveSenderInArea(user.id, 'desk');
      expect(chosen.id).toBe(main.id);
      expect(chosen.id).not.toBe(other.id);
    });
  });

  it('names the area in the refusal, so the message says what to connect', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      await expect(mailer(tx).resolveSenderInArea(user.id, 'desk'))
        .rejects.toThrow(/Transaction Desk/i);
    });
  });
});
