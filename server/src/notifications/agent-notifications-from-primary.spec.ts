import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { MailAccountService } from '../email/mail-account.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { CrmEventNotifier } from './crm-events.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPreferenceService } from './notification-preference.service';

/**
 * WHAT AN AGENT SEES IN THE "FROM" LINE of the mail this system sends them.
 *
 * THE REQUIREMENT, in the brokerage's words: assignments, tasks and assigned leads should all reach
 * agents from `info@gethomerealty.ca` — the mailbox chosen as primary — and not from whichever
 * colleague's address the resolver happened to land on.
 *
 * WHAT WAS HAPPENING. Not one mail account in this deployment is owned by the BROKERAGE; every row
 * has a `user_id`. So the shared-account steps in the sender chain all missed and resolution fell
 * through to a person's mailbox. Two notifications about the SAME lead arrived from two different
 * addresses — `info@` and `precon@` — because the two code paths passed different users, and each
 * got that user's own default. Nobody chose either address.
 *
 * WHY THIS FILE EXISTS ON TOP OF `brokerage-primary-sender.spec.ts`. That one tests the resolvers
 * directly. Agent notifications do not call them directly: they go
 * `CrmEventNotifier` → `NotificationDispatcher.sendEmail` → `sendDirect(to, subject, html, null, [],
 * user.id)` → `resolveSender(null, userId)`. The `null` account id is the important part — the
 * dispatcher never names a mailbox, so this whole class of mail depends on the fallback order being
 * right. A change that fixed the resolvers but left the dispatcher naming something would pass there
 * and fail here.
 *
 * NOTHING IS SENT. `dispatch` — the one method that opens an SMTP connection — is replaced with a
 * recorder, so what is asserted is the account the mailer WOULD have connected as.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const crypt = new LaravelCryptService({ get: () => process.env.APP_KEY } as never);

/** This deployment's own accounts would otherwise answer every lookup. */
async function emptyAccounts(tx: PrismaService) {
  await tx.mail_accounts.updateMany({ where: { is_active: true }, data: { is_active: false } });
}

async function makeAgent(tx: PrismaService) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `ZZ Agent ${t}`, email: `zz-agent-${t}@probe.test`, username: `zzagent${t.replace(/-/g, '')}`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true, name: true, email: true },
  });
}

async function account(tx: PrismaService, from: string, over: Record<string, unknown>) {
  const now = new Date();
  const t = tag();
  return tx.mail_accounts.create({
    data: {
      name: `ZZ ${t}`, from_email: from, username: from,
      host: 'smtp.example.test', port: 587, encryption: 'tls', password: crypt.encryptString('x'),
      is_active: true, is_default: false, created_at: now, updated_at: now,
      ...over,
    },
  });
}

/**
 * The real chain, with only the SMTP connection replaced.
 *
 * `dispatch` is private, so it is overwritten on the instance rather than subclassed — the point is
 * to intercept the LAST step, after the account has been resolved, so everything under test is the
 * production code path.
 */
function build(tx: PrismaService) {
  const sentFrom: string[] = [];
  const mailer = new MailerService(tx, crypt, new MailAccountService(tx, crypt as never));
  (mailer as unknown as { dispatch: (a: { from_email: string }) => Promise<{ messageId: null }> })
    .dispatch = async (a) => { sentFrom.push(a.from_email); return { messageId: null }; };

  const moduleRef = {
    get: (type: { name: string }) => {
      if (type.name === 'MailerService') return mailer;
      throw new Error('absent');
    },
  };
  const dispatcher = new NotificationDispatcher(tx, new NotificationPreferenceService(tx), moduleRef as never);
  return { notifier: new CrmEventNotifier(dispatcher, tx), sentFrom };
}

const LEAD = { id: 4242, first_name: 'Jane', last_name: 'Buyer', email: 'jane@example.test' };
const PRIMARY = 'info@gethomerealty.ca';

describe('mail this system sends to an agent', () => {
  it('an ASSIGNED LEAD notification comes from the brokerage primary', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const agent = await makeAgent(tx);
      const actor = await makeAgent(tx);
      // The agent's own mailbox, marked as their default — this is what used to win.
      await account(tx, `zz-own-${tag()}@probe.test`, { user_id: agent.id, scope: 'crm', is_default: true });
      await account(tx, PRIMARY, { user_id: null, scope: 'crm', is_default: true });

      const { notifier, sentFrom } = build(tx);
      await notifier.leadAssigned(LEAD, agent.id, actor.id, 'Admin');

      expect(sentFrom).toEqual([PRIMARY]);
    });
  });

  it('a TASK falling due comes from the brokerage primary', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const agent = await makeAgent(tx);
      await account(tx, `zz-own-${tag()}@probe.test`, { user_id: agent.id, scope: 'crm', is_default: true });
      await account(tx, PRIMARY, { user_id: null, scope: 'crm', is_default: true });

      const { notifier, sentFrom } = build(tx);
      await notifier.leadTaskDue({ id: 1, title: 'Call back', due_at: new Date() }, LEAD, agent.id, '2026-09-28');

      expect(sentFrom).toEqual([PRIMARY]);
    });
  });

  it('a NEW LEAD notification comes from the brokerage primary', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const agent = await makeAgent(tx);
      const actor = await makeAgent(tx);
      await account(tx, `zz-own-${tag()}@probe.test`, { user_id: agent.id, scope: 'crm', is_default: true });
      await account(tx, PRIMARY, { user_id: null, scope: 'crm', is_default: true });

      const { notifier, sentFrom } = build(tx);
      await notifier.leadCreated({ ...LEAD, source: 'meta' }, agent.id, actor.id);

      expect(sentFrom).toEqual([PRIMARY]);
    });
  });

  it('TWO notifications about one lead come from the SAME address', async () => {
    /*
     * THE REPORTED SYMPTOM, pinned directly. Two mails about the same lead arrived from `info@` and
     * `precon@`, because each path passed a different user and each got that user's own default.
     * What made them differ was never a setting anyone chose.
     */
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const agent = await makeAgent(tx);
      const colleague = await makeAgent(tx);
      const actor = await makeAgent(tx);
      await account(tx, 'zz-agent-own@probe.test', { user_id: agent.id, scope: 'crm', is_default: true });
      await account(tx, 'zz-colleague-own@probe.test', { user_id: colleague.id, scope: 'crm', is_default: true });
      await account(tx, PRIMARY, { user_id: null, scope: 'crm', is_default: true });

      const { notifier, sentFrom } = build(tx);
      await notifier.leadCreated({ ...LEAD, source: 'meta' }, agent.id, actor.id);
      await notifier.leadAssigned(LEAD, colleague.id, actor.id, 'Admin');

      expect(sentFrom).toEqual([PRIMARY, PRIMARY]);
      expect(new Set(sentFrom).size).toBe(1);
    });
  });

  it('with NO primary chosen it still falls back to the agent’s own mailbox', async () => {
    /*
     * The safety property: until a primary exists nothing changes, so a brokerage that has connected
     * no shared mailbox keeps sending rather than failing. This is also what makes the code safe to
     * deploy ahead of promoting the mailbox.
     */
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const agent = await makeAgent(tx);
      const actor = await makeAgent(tx);
      const own = await account(tx, `zz-own-${tag()}@probe.test`, { user_id: agent.id, scope: 'crm', is_default: true });

      const { notifier, sentFrom } = build(tx);
      await notifier.leadAssigned(LEAD, agent.id, actor.id, 'Admin');

      expect(sentFrom).toEqual([own.from_email]);
    });
  });

  it('an INACTIVE primary is not used, because it could not send', async () => {
    await inRollback(async (tx) => {
      await emptyAccounts(tx);
      const agent = await makeAgent(tx);
      const actor = await makeAgent(tx);
      const own = await account(tx, `zz-own-${tag()}@probe.test`, { user_id: agent.id, scope: 'crm', is_default: true });
      await account(tx, PRIMARY, { user_id: null, scope: 'crm', is_default: true, is_active: false });

      const { notifier, sentFrom } = build(tx);
      await notifier.leadAssigned(LEAD, agent.id, actor.id, 'Admin');

      expect(sentFrom).toEqual([own.from_email]);
    });
  });
});
