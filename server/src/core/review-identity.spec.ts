import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionReviewService } from '../transactions/transaction-review.service';
import { transactionResource } from '../transactions/transaction.resource';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { reviewScopeWhere } from '../common/transaction-scope';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * A review decision belongs to a person, not to a name.
 *
 * THE DISCLOSURE THIS PREVENTS. A `transaction_reviews` row carries the FIELD an administrator
 * rejected, the REASON they gave, and the OLD and NEW values. On a commission percentage that is
 * somebody's pay; on a closing date it is a client's business. Five paths authorized on
 * `agent_name` — the review feed, the unread count, the Notification Centre list, mark-as-seen and
 * the dashboard's open/corrected/overdue figures — and two accounts in this brokerage have shared a
 * name. Each test below therefore builds TWO AGENTS WITH THE SAME NAME and different ids.
 *
 * The last two describe the payloads rather than the reviews: an agent must not be handed the deal's
 * audit history or its invoice block, and both used to ride along on every transaction they opened.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 20000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const asUser = (u: { id: number; name: string }, role = 'agent') =>
  ({ id: u.id, name: u.name, role, user_permissions: [] }) as unknown as AuthUserRecord;

/**
 * Two agents sharing a name, a deal owned by the first, and one open rejection on it addressed to
 * that first agent BY ID.
 */
async function scene(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const name = `Jordan Blake ${n}`;
  const mine = await tx.users.create({
    data: { name, email: `jb-a-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', created_at: now, updated_at: now },
  });
  const theirs = await tx.users.create({
    data: { name, email: `jb-b-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', created_at: now, updated_at: now },
  });
  const txn = await tx.transactions.create({
    data: { agent: name, agent_user_id: mine.id, trade_no: 'RV' + Date.now() + n, type: 'Residential Buying', created_at: now, updated_at: now },
  });
  const review = await tx.transaction_reviews.create({
    data: {
      transaction_id: txn.id,
      decision: 'Rejected',
      reason: 'Commission split does not match the signed agreement',
      field_label: 'Commission %',
      old_value: '2.5',
      new_value: '3.5',
      agent_name: name,
      agent_user_id: mine.id,
      actor_name: 'The Office',
      resolution_status: 'Open',
      created_at: now,
      updated_at: now,
    },
  });
  return { name, mine, theirs, txn, review };
}

describe('a review item reaches the agent it is about, and nobody with their name', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  const svc = (tx: PrismaService) =>
    new TransactionReviewService(tx, { resolve: async () => null } as never, { send: async () => undefined } as never,
      { current: async () => ({ name: 'Co' }) } as never, { post: async () => [] } as never);

  it('scopes the query itself by id, not by name', async () => {
    await inRollback(async (tx) => {
      const { mine, theirs, review } = await scene(tx);
      const seenBy = async (u: { id: number; name: string }) =>
        (await tx.transaction_reviews.findMany({ where: reviewScopeWhere(asUser(u)), select: { id: true } })).map((r) => r.id);

      expect(await seenBy(mine)).toContain(review.id);
      expect(await seenBy(theirs)).not.toContain(review.id);
    });
  });

  it('gives the namesake no unread review notification', async () => {
    await inRollback(async (tx) => {
      const { mine, theirs } = await scene(tx);
      expect((await svc(tx).notifications(asUser(mine))).count).toBeGreaterThan(0);
      expect((await svc(tx).notifications(asUser(theirs))).count).toBe(0);
    });
  });

  it('does not let the namesake mark it seen', async () => {
    await inRollback(async (tx) => {
      const { mine, theirs, txn, review } = await scene(tx);

      await svc(tx).markSeen({ id: theirs.id, name: theirs.name, role: 'agent' }, txn.id);
      // Untouched: it was never theirs to clear.
      expect((await tx.transaction_reviews.findUnique({ where: { id: review.id } }))?.agent_seen_at).toBeNull();

      await svc(tx).markSeen({ id: mine.id, name: mine.name, role: 'agent' }, txn.id);
      expect((await tx.transaction_reviews.findUnique({ where: { id: review.id } }))?.agent_seen_at).not.toBeNull();
    });
  });

  it('counts the open item for its own agent only', async () => {
    await inRollback(async (tx) => {
      const { mine, theirs } = await scene(tx);
      const openFor = async (u: { id: number; name: string }) => Number((await svc(tx).stats(asUser(u))).open);

      expect(await openFor(mine)).toBeGreaterThan(0);
      expect(await openFor(theirs)).toBe(0);
    });
  });

  it('keeps the name fallback for rows written before the id existed', async () => {
    await inRollback(async (tx) => {
      const { name, mine, txn } = await scene(tx);
      const legacy = await tx.transaction_reviews.create({
        data: {
          transaction_id: txn.id, decision: 'Rejected', reason: 'legacy', field_label: 'Price',
          agent_name: name, agent_user_id: null, resolution_status: 'Open',
          created_at: new Date(), updated_at: new Date(),
        },
      });
      const ids = (await tx.transaction_reviews.findMany({
        where: reviewScopeWhere(asUser(mine)), select: { id: true },
      })).map((r) => r.id);
      // Unresolved rows behave exactly as they did — no better, and no worse.
      expect(ids).toContain(legacy.id);
    });
  });

  it('leaves the office reading the brokerage', async () => {
    await inRollback(async (tx) => {
      await scene(tx);
      for (const role of ['admin', 'manager', 'accounting']) {
        expect(reviewScopeWhere({ id: 1, name: 'Anyone', role })).toEqual({});
      }
    });
  });
});

describe('a transaction payload tells an agent only what is theirs to know', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  /** A deal with an audit row and an invoice on it, serialised for one caller. */
  async function payloadFor(tx: PrismaService, role: string, user: { id: number; name: string }, txnId: number) {
    const full = await tx.transactions.findUnique({
      where: { id: txnId },
      include: { audit_logs: true, invoices: true, team_members: { include: { team_member_terms: true } }, precon_terms: true },
    });
    return transactionResource(full as never, {
      user: { id: user.id, role, name: user.name },
      // A real resolver over the same client: the commission summary reads agent profiles, and
      // the payload shape under test does not depend on the split it computes.
      commission: new CommissionService(new PersonResolver(tx)),
      prisma: tx as never,
    });
  }

  async function dealWithHistory(tx: PrismaService) {
    const now = new Date();
    const n = ++seq;
    const agent = await tx.users.create({
      data: { name: `Payload Agent ${n}`, email: `pa-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', created_at: now, updated_at: now },
    });
    const txn = await tx.transactions.create({
      data: { agent: agent.name, agent_user_id: agent.id, trade_no: 'PL' + Date.now() + n, type: 'Residential Buying', created_at: now, updated_at: now },
    });
    await tx.audit_logs.create({
      data: {
        transaction_id: txn.id, who: 'The Office', section: 'Commission Information',
        field: 'Agent %', old_value: '90', new_value: '85', action: 'Updated', source: 'Manual',
        created_at: now, updated_at: now,
      },
    });
    await tx.invoices.create({
      data: {
        invoice_no: `PL-${Date.now()}-${n}`.slice(0, 30), transaction_id: txn.id, status: 'Unpaid',
        invoice_date: now, total: 4200, amount_paid: 0, balance_due: 4200, created_at: now, updated_at: now,
      },
    });
    return { agent, txn };
  }

  it('withholds the audit history from an agent and gives it to the office', async () => {
    await inRollback(async (tx) => {
      const { agent, txn } = await dealWithHistory(tx);

      const mine = await payloadFor(tx, 'agent', agent, txn.id);
      // Absent, not empty: the rows carry the old and new value of every field the office has
      // touched, commission included.
      expect(mine.audit_logs).toBeUndefined();
      expect(mine.agent_changes).toBeUndefined();

      const office = await payloadFor(tx, 'manager', { id: 999001, name: 'An Admin' }, txn.id);
      expect(Array.isArray(office.audit_logs)).toBe(true);
      expect((office.audit_logs as unknown[]).length).toBeGreaterThan(0);
    });
  });

  it('withholds the invoice block from every role that may not open the Invoice module', async () => {
    await inRollback(async (tx) => {
      const { agent, txn } = await dealWithHistory(tx);

      for (const role of ['agent', 'documentation', 'crm']) {
        const p = await payloadFor(tx, role, agent, txn.id);
        expect(p.invoices).toBeUndefined();
        expect(p.invoice_admin).toBeUndefined();
      }

      for (const role of ['admin', 'manager', 'accounting']) {
        const p = await payloadFor(tx, role, { id: 999002, name: 'Finance' }, txn.id);
        expect(Array.isArray(p.invoices)).toBe(true);
        expect(p.invoice_admin).toBeDefined();
      }
    });
  });
});
