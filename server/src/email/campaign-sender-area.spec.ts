import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MailerService } from './mailer.service';
import { MailAccountService } from './mail-account.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';

/**
 * A CRM send leaves from a CRM mailbox, or it does not leave at all.
 *
 * WHAT WAS REPORTED. CRM Account Settings said no CRM email account was connected - and stated that
 * each area keeps its own accounts - while a CRM campaign went out from the agent's
 * TRANSACTION DESK mailbox.
 *
 * WHY IT HAPPENED, and it was already written down. `MailAccountService.senderFor` carries a comment
 * saying `MailerService.resolveSender` "never looks at `scope`, so a CRM email could leave from a
 * Transaction Desk mailbox, which is the exact cross-wiring the `scope` column was added to
 * prevent". `senderFor` was written to close that gap and the per-lead CRM paths use it. Campaigns
 * did not: they called `sendDirect`, which resolves through `resolveSender`.
 *
 * WORSE THAN CROSS-AREA. `resolveSender`'s last resort is ANY active mailbox belonging to anyone, so
 * a campaign could go out from a COLLEAGUE'S address - the code logs a warning when it does. The
 * fault was cross-person as well as cross-area.
 *
 * WHY REFUSING IS THE RIGHT ANSWER when the area has no mailbox. It is what the rest of the CRM
 * already does - `CrmAdvancedEmailService` declines rather than borrowing - and it is what CRM
 * Account Settings already tells the reader happens. A brokerage marketing message leaving from an
 * arbitrary mailbox is a worse outcome than a send that stops and says why.
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
  it('uses the sender’s CRM mailbox, not their Transaction Desk one', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const desk = await account(tx, { user_id: user.id, scope: 'desk', is_default: true });
      const crm = await account(tx, { user_id: user.id, scope: 'crm' });

      const chosen = await mailer(tx).resolveSenderInArea(user.id, 'crm');

      // THE DEFECT: this returned the Desk account, because it was the user's default and nothing
      // in the resolution looked at `scope`.
      expect(chosen.id).toBe(crm.id);
      expect(chosen.id).not.toBe(desk.id);
    });
  });

  it('refuses rather than borrowing when the area has no mailbox', async () => {
    /*
     * The behaviour change worth stating plainly: a campaign that previously went out from a Desk
     * mailbox now stops. That is the existing CRM rule, applied to campaigns for the first time.
     */
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      await account(tx, { user_id: user.id, scope: 'desk', is_default: true });

      await expect(mailer(tx).resolveSenderInArea(user.id, 'crm'))
        .rejects.toThrow(/No active CRM email account is connected/i);
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

  it('the Transaction Desk keeps its own answer, unchanged', async () => {
    // The fix is symmetrical: a Desk send must not start using a CRM mailbox either.
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const user = await makeUser(tx);
      const crm = await account(tx, { user_id: user.id, scope: 'crm', is_default: true });
      const desk = await account(tx, { user_id: user.id, scope: 'desk' });

      const chosen = await mailer(tx).resolveSenderInArea(user.id, 'desk');
      expect(chosen.id).toBe(desk.id);
      expect(chosen.id).not.toBe(crm.id);
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
