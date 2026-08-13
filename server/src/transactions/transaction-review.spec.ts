import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionReviewService, REVERT_OK, REVERT_UNSUPPORTED } from './transaction-review.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { PersonResolver } from '../core/person-resolver.service';

/**
 * The review lifecycle, against the real schema, inside transactions that are rolled back.
 *
 * What is worth proving here is not that a row can be inserted — it is the three promises the
 * feature makes and the old behaviour broke:
 *
 *   a rejection is never lost because the field could not be reverted
 *   a rejection cannot exist without a reason
 *   one issue is ONE row from Rejected through Corrected to Resolved, not three unrelated ones
 *
 * The chat post and the email are stubbed. Both are best-effort by design and neither is the thing
 * under test; what matters is that a failure in either cannot stop the record being written, which
 * is asserted directly.
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

/** Nothing here should reach a mail server or a chat thread. */
const stubs = () => {
  const posted: string[] = [];
  const mailed: Record<string, unknown>[] = [];
  const mailer = { send: async (_k: string, vars: Record<string, unknown>) => { mailed.push(vars); } };
  const settings = { current: async () => ({ name: 'Test Brokerage' }) };
  const messages = { post: async (_id: number, _u: unknown, body: string) => { posted.push(body); return []; } };
  return { posted, mailed, mailer, settings, messages };
};

const serviceFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new TransactionReviewService(
    tx,
    new PersonResolver(tx),
    s.mailer as never,
    s.settings as never,
    s.messages as never,
  );

/** A deal to hang reviews off. Rolled back with everything else. */
async function makeTxn(tx: PrismaService, agent = 'Test Agent'): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: { trade_no: `RV-${Date.now()}-${seq}`, type: 'Residential Buying', agent, created_at: now, updated_at: now },
  });
  return t.id;
}

describe('a rejection is recorded whatever happens to the value', () => {
  it('records the reason and says the value was put back when it could be', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const review = await serviceFor(tx, s).recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: 'Purchase price does not match the APS.',
        fieldLabel: 'Purchase Price', oldValue: '500000', newValue: '520000', agentName: 'Test Agent',
        autoReverted: true,
      });

      expect(review.decision).toBe('Rejected');
      expect(review.reason).toBe('Purchase price does not match the APS.');
      expect(review.auto_reverted).toBe(true);
      expect(review.auto_revert_result).toBe(REVERT_OK);
      expect(review.resolution_status).toBe('Open');
      // The snapshot is the point: these must not be re-read from the deal later.
      expect(review.old_value).toBe('500000');
      expect(review.new_value).toBe('520000');
    });
  });

  it('still records it when the field cannot be reverted — the old behaviour threw instead', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const review = await serviceFor(tx, s).recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: 'Wrong closing date.',
        fieldLabel: 'Closing Date', oldValue: '2026-01-01', newValue: '2026-02-01', agentName: 'Test Agent',
        autoReverted: false,
      });

      expect(review.decision).toBe('Rejected');
      expect(review.auto_reverted).toBe(false);
      expect(review.auto_revert_result).toBe(REVERT_UNSUPPORTED);
      expect(review.resolution_status).toBe('Open');
    });
  });

  it('refuses a rejection with no reason, and writes nothing', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const svc = serviceFor(tx, s);
      const attempt = svc.recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: '   ',
        fieldLabel: 'Purchase Price', oldValue: '1', newValue: '2', agentName: 'Test Agent', autoReverted: false,
      });
      await expect(attempt).rejects.toThrow(/reason is required/i);
      expect(await tx.transaction_reviews.count({ where: { transaction_id: txnId } })).toBe(0);
    });
  });

  it('tells the agent and the team — one chat line, one email', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      await serviceFor(tx, s).recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: 'Does not match the APS.',
        fieldLabel: 'Purchase Price', oldValue: '1', newValue: '2', agentName: 'Test Agent', autoReverted: false,
      });
      expect(s.posted).toHaveLength(1);
      expect(s.posted[0]).toContain('Purchase Price rejected.');
      expect(s.posted[0]).toContain('Does not match the APS.');
      // No user row for "Test Agent" in this rolled-back world, so no address to send to.
      expect(s.mailed).toHaveLength(0);
    });
  });

  it('writes the record even when the chat and the email both fail', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      s.messages.post = async () => { throw new Error('chat down'); };
      s.mailer.send = async () => { throw new Error('smtp down'); };
      const txnId = await makeTxn(tx);
      const review = await serviceFor(tx, s).recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: 'Still recorded.',
        fieldLabel: 'Purchase Price', oldValue: '1', newValue: '2', agentName: 'Test Agent', autoReverted: false,
      });
      expect(review.id).toBeGreaterThan(0);
      expect(await tx.transaction_reviews.count({ where: { transaction_id: txnId } })).toBe(1);
    });
  });
});

describe('one issue is one row, from Rejected to Resolved', () => {
  it('marks the original rejection Corrected when the agent edits the same field again', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const svc = serviceFor(tx, s);
      const review = await svc.recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: 'Does not match the APS.',
        fieldLabel: 'Purchase Price', oldValue: '500000', newValue: '520000', agentName: 'Test Agent',
        autoReverted: false,
      });

      const moved = await svc.markCorrected(txnId, 'Test Agent', ['Purchase Price', 'Closing Date']);
      expect(moved).toBe(1);

      const after = await tx.transaction_reviews.findUnique({ where: { id: review.id } });
      expect(after?.resolution_status).toBe('Corrected');
      expect(after?.corrected_by).toBe('Test Agent');
      expect(after?.corrected_at).toBeTruthy();
      // No second record: the correction belongs to the rejection it answers.
      expect(await tx.transaction_reviews.count({ where: { transaction_id: txnId } })).toBe(1);
    });
  });

  it('leaves an untouched field alone', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const svc = serviceFor(tx, s);
      const review = await svc.recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: 'Wrong.',
        fieldLabel: 'Purchase Price', oldValue: '1', newValue: '2', agentName: 'Test Agent', autoReverted: false,
      });
      expect(await svc.markCorrected(txnId, 'Test Agent', ['Closing Date'])).toBe(0);
      expect((await tx.transaction_reviews.findUnique({ where: { id: review.id } }))?.resolution_status).toBe('Open');
    });
  });

  it('resolves what was corrected when the office marks the deal reviewed', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const svc = serviceFor(tx, s);
      const rejection = await svc.recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: 'Does not match the APS.',
        fieldLabel: 'Purchase Price', oldValue: '500000', newValue: '520000', agentName: 'Test Agent',
        autoReverted: false,
      });
      await svc.markCorrected(txnId, 'Test Agent', ['Purchase Price']);
      await svc.recordReviewed(txnId, ADMIN, 'Verified against APS.', 'Test Agent');

      const closed = await tx.transaction_reviews.findUnique({ where: { id: rejection.id } });
      expect(closed?.resolution_status).toBe('Resolved');
      expect(closed?.resolved_by).toBe('Office Admin');
      expect(closed?.auto_revert_result).toBe('Approved after correction. Verified against APS.');
      // The original reason survives — the record still says what was wrong as well as that it is
      // now right.
      expect(closed?.reason).toBe('Does not match the APS.');
      expect(s.posted.some((p) => p.includes('1 earlier rejection approved after correction.'))).toBe(true);
    });
  });

  it('does not resolve an issue the agent has not corrected', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const svc = serviceFor(tx, s);
      const rejection = await svc.recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: 'Still wrong.',
        fieldLabel: 'Purchase Price', oldValue: '1', newValue: '2', agentName: 'Test Agent', autoReverted: false,
      });
      await svc.recordReviewed(txnId, ADMIN, null, 'Test Agent');
      expect((await tx.transaction_reviews.findUnique({ where: { id: rejection.id } }))?.resolution_status).toBe('Open');
    });
  });
});

describe('the history reads back', () => {
  it('lists newest first, counts what is open, and filters', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx);
      const svc = serviceFor(tx, s);
      await svc.recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: 'One.', fieldLabel: 'Purchase Price',
        oldValue: '1', newValue: '2', agentName: 'Test Agent', autoReverted: false,
      });
      await svc.recordRejection({
        txnId, actor: ADMIN, auditLogId: null, reason: 'Two.', fieldLabel: 'Closing Date',
        oldValue: 'a', newValue: 'b', agentName: 'Test Agent', autoReverted: false,
      });

      const all = await svc.list(ADMIN, txnId, {});
      expect((all.data as unknown[]).length).toBe(2);
      expect((all.meta as { open_count: number }).open_count).toBe(2);
      expect((all.meta as { can_decide: boolean }).can_decide).toBe(true);

      const byField = await svc.list(ADMIN, txnId, { field: 'closing' });
      expect((byField.data as { field_label: string }[]).map((r) => r.field_label)).toEqual(['Closing Date']);

      const open = await svc.list(ADMIN, txnId, { resolution: 'Open' });
      expect((open.data as unknown[]).length).toBe(2);
      const resolved = await svc.list(ADMIN, txnId, { resolution: 'Resolved' });
      expect((resolved.data as unknown[]).length).toBe(0);
    });
  });

  it('does not let an agent read another agent’s deal', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const txnId = await makeTxn(tx, 'Someone Else');
      const svc = serviceFor(tx, s);
      const stranger = { id: 9, name: 'Test Agent', role: 'agent' } as AuthUserRecord;
      await expect(svc.list(stranger, txnId, {})).rejects.toThrow(/do not have access/i);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
