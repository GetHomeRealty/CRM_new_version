import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { transactionResource, txnShowIncludeFor } from './transaction.resource';

/**
 * TD-110 — an agent can see what THEY changed on their own deal.
 *
 * THE DEFECT. The whole `audit_logs` relation was withheld from agents, and with it every trace of
 * their own edits: reading a deal as its own agent returned no history of any kind, while an
 * administrator reading the same deal saw the agent's changes listed. The person most likely to be
 * asked to account for a change was the one person who could not see it.
 *
 * AND IT ANSWERS THE QUESTION THE ENTRY COULD NOT SETTLE FROM THE AGENT SEAT — were the changes
 * never recorded, or recorded and hidden? The first test writes an agent's change and then reads
 * the same deal from both seats: the row is there for the administrator throughout. It was always
 * recorded; it was filtered out on the way to its author.
 *
 * WHAT IS NOT DONE, deliberately. `agent_changes` is the OFFICE's review queue — unhandled edits
 * awaiting a decision, including colleagues' on a team deal — and is still withheld. So is
 * `audit_logs`, which carries every commission figure the office has ever touched. The agent gets
 * `my_changes`: their own rows, handled ones included, so a change that was reverted is visible to
 * the person who made it.
 *
 * The include is narrowed to the caller's own rows, so the reason the relation was dropped for
 * agents — reading an unbounded history off disk to throw it away — does not come back with it.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

interface Payload { my_changes?: { field?: string | null; handled?: boolean }[]; agent_changes?: unknown[]; audit_logs?: unknown[] }

/** The deal as one caller receives it, loaded with that caller's own include. */
const payloadFor = async (
  tx: PrismaService,
  txnId: number,
  user: { id: number; name: string; role: string },
): Promise<Payload> => {
  const full = await tx.transactions.findUnique({ where: { id: txnId }, include: txnShowIncludeFor(user) });
  return await transactionResource(full as never, {
    user,
    commission: new CommissionService(new PersonResolver(tx)),
    prisma: tx as never,
  }) as unknown as Payload;
};

async function scene(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const mk = async (label: string, role: string) => tx.users.create({
    data: {
      name: `${label} ${Date.now()}-${n}`, email: `${label}-${Date.now()}-${n}@x.test`, password: 'x',
      role, status: 'Active', created_at: now, updated_at: now,
    },
  });
  const agent = await mk('TD110Agent', 'agent');
  const other = await mk('TD110Other', 'agent');
  const deal = await tx.transactions.create({
    data: {
      trade_no: `TD110-${Date.now()}-${n}`, type: 'Residential Buying', property: '1 History Road',
      agent: agent.name, agent_user_id: agent.id,
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
    },
  });

  const log = async (who: { id: number; name: string }, field: string, source: string, handled = false) =>
    tx.audit_logs.create({
      data: {
        transaction_id: deal.id, who: who.name, user_id: who.id, section: 'Basic Information',
        field, old_value: 'before', new_value: 'after', action: 'Updated', source, handled,
        created_at: now, updated_at: now,
      },
    });

  await log(agent, 'Price', 'Agent');
  await log(agent, 'Deposit', 'Agent', true);          // already dealt with by the office
  await log(other, 'Property Address', 'Agent');       // a colleague's edit on the same deal
  await log({ id: 990_110, name: 'The Office' }, 'Agent %', 'Manual'); // an office change
  return { deal, agent, other };
}

describe('an agent sees their own change history on their own deal (TD-110)', () => {
  jest.setTimeout(120_000);

  it('shows the agent the changes THEY made', async () => {
    await inRollback(async (tx) => {
      const { deal, agent } = await scene(tx);
      const mine = await payloadFor(tx, deal.id, { id: agent.id, name: agent.name, role: 'agent' });

      expect(mine.my_changes?.map((c) => c.field).sort()).toEqual(['Deposit', 'Price']);
    });
  });

  it('includes a change the office has already handled, so a revert is visible to its author', async () => {
    await inRollback(async (tx) => {
      const { deal, agent } = await scene(tx);
      const mine = await payloadFor(tx, deal.id, { id: agent.id, name: agent.name, role: 'agent' });

      expect(mine.my_changes?.find((c) => c.field === 'Deposit')?.handled).toBe(true);
    });
  });

  it('shows them nothing of the office\'s history or a colleague\'s edits', async () => {
    await inRollback(async (tx) => {
      const { deal, agent } = await scene(tx);
      const mine = await payloadFor(tx, deal.id, { id: agent.id, name: agent.name, role: 'agent' });

      expect(mine.audit_logs).toBeUndefined();
      expect(mine.agent_changes).toBeUndefined();
      expect(JSON.stringify(mine)).not.toContain('Agent %');
      expect(JSON.stringify(mine)).not.toContain('Property Address');
    });
  });

  it('was always recorded — the administrator saw it throughout', async () => {
    // The question the agent seat could not settle: never written, or written and hidden?
    await inRollback(async (tx) => {
      const { deal, agent } = await scene(tx);
      const office = await payloadFor(tx, deal.id, { id: 990_111, name: 'An Admin', role: 'admin' });

      expect((office.audit_logs ?? []).length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(office.audit_logs)).toContain(agent.name);
      // And the office keeps its review queue, which agents are still not sent.
      expect(office.agent_changes).toBeDefined();
      expect(office.my_changes).toBeUndefined();
    });
  });

  it('matches a legacy row by name when it carries no user id', async () => {
    // Rows written before `audit_logs.user_id` existed are still that person's history.
    await inRollback(async (tx) => {
      const { deal, agent } = await scene(tx);
      await tx.audit_logs.create({
        data: {
          transaction_id: deal.id, who: agent.name, user_id: null, section: 'Basic Information',
          field: 'Legacy Field', action: 'Updated', source: 'Agent', created_at: new Date(), updated_at: new Date(),
        },
      });

      const mine = await payloadFor(tx, deal.id, { id: agent.id, name: agent.name, role: 'agent' });
      expect(mine.my_changes?.map((c) => c.field)).toContain('Legacy Field');
    });
  });
});
