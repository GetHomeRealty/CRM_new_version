import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MailerService } from '../email/mailer.service';
import { PersonResolver } from '../core/person-resolver.service';
import { AuditService } from '../audit/audit.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { TransactionLawyerReminderService } from './transaction-lawyer-reminder.service';

/**
 * TD-189 - a reminder reaches the person the deal is LINKED to, whatever their name says today.
 *
 * Measured 2026-09-16: eight users were renamed in a routine clean-up, and five of the names still
 * written on their deals resolved to nobody - 'satish yangala' -> 'Satish Yangala' was a change of
 * capital letters. 54 linked deals would have had every reminder skipped as "no email address on
 * file", silently. The deals knew exactly whose they were; the lookup never asked.
 *
 * The mailer is a recorder. Nothing leaves the building.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

async function makeUser(tx: PrismaService, name: string, status = 'Active'): Promise<{ id: number; email: string }> {
  const t = tag();
  const now = new Date();
  const email = `zz-td189-${t}@example.test`;
  const u = await tx.users.create({
    data: { name, email, username: `zztd189${t.replace(/-/g, '')}`, role: 'agent', status, password: 'x', created_at: now, updated_at: now },
    select: { id: true },
  });
  return { id: u.id, email };
}

/** A live buying deal, lawyer names blank, carrying the agent's OLD spelling but linked to the account. */
async function makeDeal(tx: PrismaService, agentText: string, agentUserId: number | null): Promise<number> {
  const now = new Date();
  const d = await tx.transactions.create({
    data: {
      trade_no: `TD189-${tag()}`, type: 'Residential Buying', property: '9 Rename Row',
      agent: agentText, agent_user_id: agentUserId, closing_date: new Date(Date.now() + 14 * 864e5),
      created_at: now, updated_at: now,
    },
  });
  await tx.transaction_statuses.create({ data: { transaction_id: d.id, status: 'Secured Firm', created_at: now, updated_at: now } });
  return d.id;
}

function sweepFor(tx: PrismaService): { svc: ReminderSweepService; sent: string[] } {
  const sent: string[] = [];
  const mailer = { send: async (_event: string, _vars: unknown, to: string) => { sent.push(to); } };
  const settings = { current: async () => ({ name: 'ZZ Brokerage' }) };
  return { svc: new ReminderSweepService(tx, new PersonResolver(tx), mailer as never, settings as never, new AuditService(tx)), sent };
}

function lawyerFor(tx: PrismaService): { svc: TransactionLawyerReminderService; sent: string[] } {
  const sent: string[] = [];
  const mailer = { sendDirect: async (to: string) => { sent.push(to); } } as unknown as MailerService;
  return { svc: new TransactionLawyerReminderService(tx, mailer), sent };
}

describe('a renamed agent still gets their reminders (TD-189)', () => {
  it('reaches the linked account although the deal carries the old spelling', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, `ZZ New Name ${tag()}`);
      const id = await makeDeal(tx, 'zz old name', u.id);
      const { svc, sent } = sweepFor(tx);

      await svc.statusChanged(id, ['Closed'], 'ZZ Office', []);

      expect(sent).toEqual([u.email]);
    });
  }, 60000);

  it('files the in-app reminder under the name the account carries today, which is what the bell reads', async () => {
    await inRollback(async (tx) => {
      const name = `ZZ Bell Name ${tag()}`;
      const u = await makeUser(tx, name);
      const id = await makeDeal(tx, 'zz bell old', u.id);
      const { svc } = sweepFor(tx);

      await svc.statusChanged(id, ['Closed'], 'ZZ Office', []);

      const row = await tx.transaction_reminders.findFirst({ where: { transaction_id: id, delivery_method: 'in-app' } });
      expect(row?.recipient).toBe(name);
      expect((await svc.notifications(name)).count).toBe(1);
    });
  }, 60000);

  it('still finds an agent by name when the deal is not linked to an account', async () => {
    await inRollback(async (tx) => {
      const name = `ZZ Plain Name ${tag()}`;
      const u = await makeUser(tx, name);
      const id = await makeDeal(tx, name, null);
      const { svc, sent } = sweepFor(tx);

      await svc.statusChanged(id, ['Closed'], 'ZZ Office', []);

      expect(sent).toEqual([u.email]);
    });
  }, 60000);

  it('does not email an agent about a change they made themselves, after a rename', async () => {
    await inRollback(async (tx) => {
      const name = `ZZ Self Name ${tag()}`;
      const u = await makeUser(tx, name);
      const id = await makeDeal(tx, 'zz self old', u.id);
      const { svc, sent } = sweepFor(tx);

      await svc.statusChanged(id, ['Closed'], name, []);

      expect(sent).toEqual([]);
    });
  }, 60000);

  it('sends the save-time lawyer reminder to the linked account after a rename', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, `ZZ Lawyer New ${tag()}`);
      const id = await makeDeal(tx, 'zz lawyer old', u.id);
      const { svc, sent } = lawyerFor(tx);

      await svc.maybeRemind(id);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(u.email);
    });
  }, 60000);

  it('does not send the save-time lawyer reminder to an agent who has left', async () => {
    await inRollback(async (tx) => {
      const name = `ZZ Left Agent ${tag()}`;
      const u = await makeUser(tx, name, 'Inactive');
      const id = await makeDeal(tx, name, u.id);
      const { svc, sent } = lawyerFor(tx);

      await svc.maybeRemind(id);

      expect(sent).toEqual([]);
    });
  }, 60000);
});
