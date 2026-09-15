import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MailerService } from '../email/mailer.service';
import { TransactionLawyerReminderService } from './transaction-lawyer-reminder.service';

/**
 * TD-188 — the save-time lawyer reminder must ask the same question the nightly sweep asks.
 *
 * On 2026-09-13 the master-sheet import saved 852 deals. This path fired on every buying deal with
 * blank lawyer details and had no finished-deal check at all: 267 emails to 55 agents, 235 about
 * deals recorded Closed, Terminated or Mutual Release. One agent replied that his had closed in
 * February; another asked why a mutual release needed a lawyer.
 *
 * BOTH HALVES ARE ASSERTED, and the second is the one that matters. The brokerage's own objection
 * to the first proposal was that suppressing these on import would lose a reminder a live deal
 * genuinely needs. It would have. So a live deal is still chased, and that is pinned here.
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

/** The mailer is a recorder: this asserts what WOULD be sent, and nothing leaves the building. */
function serviceFor(tx: PrismaService): { svc: TransactionLawyerReminderService; sent: string[] } {
  const sent: string[] = [];
  const mailer = { sendDirect: async (to: string, subject: string) => { sent.push(`${to} :: ${subject}`); } } as unknown as MailerService;
  return { svc: new TransactionLawyerReminderService(tx, mailer), sent };
}

async function makeAgent(tx: PrismaService): Promise<string> {
  seq += 1;
  const t = `${Date.now()}-${seq}`;
  const now = new Date();
  const name = `ZZ Lawyer Agent ${t}`;
  await tx.users.create({
    data: {
      name, email: `zz-lawyer-${t}@probe.test`, username: `zzlaw${t.replace(/-/g, '')}`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
  });
  return name;
}

/** A buying deal with both lawyer names blank, closing in a fortnight. */
async function makeDeal(tx: PrismaService, agentName: string, status: string | null): Promise<number> {
  seq += 1;
  const now = new Date();
  const d = await tx.transactions.create({
    data: {
      trade_no: `TD188-${Date.now()}-${seq}`, type: 'Residential Buying', property: '12 Settled Way',
      agent: agentName, closing_date: new Date(Date.now() + 14 * 86400000), created_at: now, updated_at: now,
    },
  });
  if (status) {
    await tx.transaction_statuses.create({ data: { transaction_id: d.id, status, created_at: now, updated_at: now } });
  }
  return d.id;
}

describe('the save-time lawyer reminder (TD-188)', () => {
  it('does not chase a deal that has already finished', async () => {
    for (const status of ['Closed', 'Mutual Release', 'Terminated']) {
      await inRollback(async (tx) => {
        const agent = await makeAgent(tx);
        const id = await makeDeal(tx, agent, status);
        const { svc, sent } = serviceFor(tx);

        await svc.maybeRemind(id);

        expect({ status, sent }).toEqual({ status, sent: [] });
      });
    }
  }, 60000);

  it('still chases a live deal, which is the half that must not be lost', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, agent, 'Secured Firm');
      const { svc, sent } = serviceFor(tx);

      await svc.maybeRemind(id);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('lawyer details missing');
      expect(sent[0]).toContain('@probe.test');
    });
  }, 60000);

  it('still chases a deal with no status recorded at all', async () => {
    // Not settled, so it IS chased — stated explicitly so nobody later reads the fix as
    // "only chase deals that say they are live".
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, agent, null);
      const { svc, sent } = serviceFor(tx);

      await svc.maybeRemind(id);

      expect(sent).toHaveLength(1);
    });
  }, 60000);
});
