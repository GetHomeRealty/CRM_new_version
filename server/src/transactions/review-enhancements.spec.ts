import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionReviewService } from './transaction-review.service';
import { ReviewSlaService } from './review-sla.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { PersonResolver } from '../core/person-resolver.service';

/**
 * The enhancements around the review lifecycle: the reminder ladder, bulk decisions, the dashboard
 * figures and the per-deal counters.
 *
 * The ladder is the part most worth pinning down. It sends real email on a timer, so the two ways
 * it can go wrong are both expensive: sending the same reminder every hour for ever, or climbing
 * two rungs at once and telling the office about something the agent was never chased for.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

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

const ADMIN: AuthUserRecord = { id: 1, name: 'Office Admin', role: 'admin' } as AuthUserRecord;
const AGENT: AuthUserRecord = { id: 2, name: 'Test Agent', role: 'agent' } as AuthUserRecord;

const stubs = () => {
  const posted: string[] = [];
  const sent: { event: string; to: unknown }[] = [];
  return {
    posted,
    sent,
    mailer: { send: async (event: string, _v: unknown, to: unknown) => { sent.push({ event, to }); } },
    settings: { current: async () => ({ name: 'Test Brokerage' }) },
    messages: { post: async (_i: number, _u: unknown, body: string) => { posted.push(body); return []; } },
  };
};

const reviewsFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new TransactionReviewService(tx, new PersonResolver(tx), s.mailer as never, s.settings as never, s.messages as never);
const slaFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new ReviewSlaService(tx, new PersonResolver(tx), s.mailer as never, s.settings as never);

async function makeTxn(tx: PrismaService, agent = 'Test Agent'): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: { trade_no: `RE-${Date.now()}-${seq}`, type: 'Residential Buying', agent, property: '1 Test Road', company_id: 1, created_at: now, updated_at: now },
  });
  return t.id;
}

/**
 * An agent with an address on file, so the reminder has somewhere to go.
 *
 * The name is unique per call: `users.name` is a join key and carries a unique constraint, so a
 * fixed name would make the second test in a run collide with the first.
 */
async function makeAgent(tx: PrismaService): Promise<string> {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  const u = await tx.users.create({
    data: {
      name: `SLA Agent ${tag}`, email: `sla-${tag}@example.test`, role: 'agent',
      status: 'Active', password: 'x', company_id: 1, created_at: now, updated_at: now,
    },
  });
  return u.name;
}

/** A rejection that was raised `hoursAgo` hours ago. */
async function openRejection(tx: PrismaService, txnId: number, hoursAgo: number, field = 'Purchase Price') {
  const at = new Date(Date.now() - hoursAgo * 3600_000);
  return tx.transaction_reviews.create({
    data: {
      transaction_id: txnId, decision: 'Rejected', reason: 'Does not match the APS.',
      field_label: field, old_value: '1', new_value: '2', agent_name: 'Test Agent',
      actor_name: 'Office Admin', resolution_status: 'Open', company_id: 1,
      created_at: at, updated_at: at,
    },
  });
}

describe('the reminder ladder', () => {
  it('leaves an item younger than a day alone', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const r = await openRejection(tx, txnId, 2);
      const result = await slaFor(tx, s).sweep();
      expect(result.reminded).toBe(0);
      expect((await tx.transaction_reviews.findUnique({ where: { id: r.id } }))?.sla_stage).toBe(0);
    });
  });

  it('chases once after a day and does not chase again on the next sweep', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const r = await openRejection(tx, txnId, 30);
      const sla = slaFor(tx, s);

      expect((await sla.sweep()).reminded).toBe(1);
      expect((await tx.transaction_reviews.findUnique({ where: { id: r.id } }))?.sla_stage).toBe(1);

      // The second pass must find nothing: this is what stops an hourly timer becoming an hourly email.
      expect((await sla.sweep()).reminded).toBe(0);
    });
  });

  it('escalates to the office at a week, and mails the agent once', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      // A real agent record, so the address lookup finds somebody and the mail path actually runs.
      const agent = await makeAgent(tx);
      const txnId = await makeTxn(tx, agent);
      const r = await openRejection(tx, txnId, 200);
      await tx.transaction_reviews.update({ where: { id: r.id }, data: { agent_name: agent } });

      const result = await slaFor(tx, s).sweep();
      expect(result.reminded).toBe(1);
      expect(result.escalated).toBe(1);
      // Highest rung first: one pass, not three rungs of catching up.
      expect(s.sent.filter((m) => m.event === 'transaction.review_reminder')).toHaveLength(1);
      expect(s.sent.filter((m) => m.event === 'transaction.review_escalation')).toHaveLength(1);
      expect((await tx.transaction_reviews.findUnique({ where: { id: r.id } }))?.sla_stage).toBe(3);
    });
  });

  it('does not escalate an item that has only been open a day', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const txnId = await makeTxn(tx, agent);
      const r = await openRejection(tx, txnId, 30);
      await tx.transaction_reviews.update({ where: { id: r.id }, data: { agent_name: agent } });

      const result = await slaFor(tx, s).sweep();
      expect(result.escalated).toBe(0);
      expect(s.sent.filter((m) => m.event === 'transaction.review_escalation')).toHaveLength(0);
    });
  });

  it('stops chasing an item the agent has corrected', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const r = await openRejection(tx, txnId, 200);
      await tx.transaction_reviews.update({ where: { id: r.id }, data: { resolution_status: 'Corrected' } });
      expect((await slaFor(tx, s).sweep()).reminded).toBe(0);
    });
  });
});

describe('bulk decisions', () => {
  it('rejects several under one reason, each becoming its own record', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const svc = reviewsFor(tx, s);
      const done: number[] = [];

      const result = await svc.bulkReject(ADMIN, [11, 22, 33], 'None of this matches the APS.', async (auditId, reason) => {
        done.push(auditId);
        await svc.recordRejection({
          txnId, actor: ADMIN, auditLogId: auditId, reason,
          fieldLabel: `Field ${auditId}`, oldValue: 'a', newValue: 'b', agentName: 'Test Agent', autoReverted: false,
        });
      });

      expect(result.rejected).toBe(3);
      expect(done).toEqual([11, 22, 33]);
      const rows = await tx.transaction_reviews.findMany({ where: { transaction_id: txnId } });
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.reason))).toEqual(new Set(['None of this matches the APS.']));
    });
  });

  it('refuses a bulk rejection with no reason', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      await expect(reviewsFor(tx, s).bulkReject(ADMIN, [1], '  ', async () => {})).rejects.toThrow(/reason is required/i);
    });
  });

  it('reports the ones it could not reject rather than dropping them', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const result = await reviewsFor(tx, s).bulkReject(ADMIN, [1, 2], 'Wrong.', async (auditId) => {
        if (auditId === 2) throw new Error('Change not found.');
      });
      expect(result.rejected).toBe(1);
      expect(result.skipped).toEqual([{ audit_id: 2, reason: 'Change not found.' }]);
    });
  });

  it('approves corrected items in bulk and leaves open ones alone', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const svc = reviewsFor(tx, s);
      const corrected = await openRejection(tx, txnId, 5, 'Purchase Price');
      const stillOpen = await openRejection(tx, txnId, 5, 'Closing Date');
      await tx.transaction_reviews.update({ where: { id: corrected.id }, data: { resolution_status: 'Corrected' } });

      const result = await svc.bulkResolve(ADMIN, txnId, [corrected.id, stillOpen.id], 'Checked against the APS.');
      expect(result).toEqual({ resolved: 1, skipped: 1 });
      expect((await tx.transaction_reviews.findUnique({ where: { id: corrected.id } }))?.resolution_status).toBe('Resolved');
      // An open item has not been fixed; approving it would close something nobody addressed.
      expect((await tx.transaction_reviews.findUnique({ where: { id: stillOpen.id } }))?.resolution_status).toBe('Open');
    });
  });

  it('lets nobody below administrator decide in bulk', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      await expect(reviewsFor(tx, s).bulkResolve(AGENT, txnId, [1], null)).rejects.toThrow(/Administrator access required/i);
    });
  });
});

describe('the dashboard figures and list counters', () => {
  it('counts open, overdue and awaiting-approval, and times what resolved', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      await openRejection(tx, txnId, 2, 'Fresh');       // open, not yet overdue
      await openRejection(tx, txnId, 40, 'Stale');      // open and overdue
      const corrected = await openRejection(tx, txnId, 10, 'Fixed');
      await tx.transaction_reviews.update({ where: { id: corrected.id }, data: { resolution_status: 'Corrected' } });
      const resolved = await openRejection(tx, txnId, 10, 'Done');
      await tx.transaction_reviews.update({
        where: { id: resolved.id },
        data: { resolution_status: 'Resolved', resolved_at: new Date(Date.now() - 4 * 3600_000) },
      });

      const stats = await reviewsFor(tx, s).stats(ADMIN) as Record<string, number | string>;
      expect(stats.open).toBe(2);
      expect(stats.overdue).toBe(1);
      expect(stats.corrected).toBe(1);
      expect(stats.scope).toBe('brokerage');
      // Raised 10h ago, resolved 4h ago — six hours in hand.
      expect(stats.average_resolution_hours).toBe(6);
    });
  });

  it('gives an agent their own figures, not the brokerage', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const mine = await makeTxn(tx, 'Test Agent');
      const theirs = await makeTxn(tx, 'Someone Else');
      await openRejection(tx, mine, 5);
      const other = await openRejection(tx, theirs, 5);
      await tx.transaction_reviews.update({ where: { id: other.id }, data: { agent_name: 'Someone Else' } });

      const stats = await reviewsFor(tx, s).stats(AGENT) as Record<string, number | string>;
      expect(stats.open).toBe(1);
      expect(stats.scope).toBe('own');
    });
  });

  it('counts per transaction for a page of the list in one query', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const a = await makeTxn(tx);
      const b = await makeTxn(tx);
      await openRejection(tx, a, 5);
      await openRejection(tx, a, 5, 'Second');
      const done = await openRejection(tx, b, 5);
      await tx.transaction_reviews.update({ where: { id: done.id }, data: { resolution_status: 'Resolved' } });

      const counts = await reviewsFor(tx, s).countsFor([a, b, 999999]);
      expect(counts[a]).toEqual({ open: 2, corrected: 0, resolved: 0 });
      expect(counts[b]).toEqual({ open: 0, corrected: 0, resolved: 1 });
      // A deal with no history is absent rather than a row of zeroes.
      expect(counts[999999]).toBeUndefined();
    });
  });

  it('lists what blocks a close, open and corrected alike', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      await openRejection(tx, txnId, 5, 'Purchase Price');
      const corrected = await openRejection(tx, txnId, 5, 'Closing Date');
      await tx.transaction_reviews.update({ where: { id: corrected.id }, data: { resolution_status: 'Corrected' } });
      const resolved = await openRejection(tx, txnId, 5, 'Deposit');
      await tx.transaction_reviews.update({ where: { id: resolved.id }, data: { resolution_status: 'Resolved' } });

      const summary = await reviewsFor(tx, s).openSummary(ADMIN, txnId) as { meta: Record<string, number | boolean> };
      expect(summary.meta.total).toBe(2);
      expect(summary.meta.open).toBe(1);
      expect(summary.meta.corrected).toBe(1);
      expect(summary.meta.blocks_closing).toBe(true);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
