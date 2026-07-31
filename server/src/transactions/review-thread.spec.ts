import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReviewThreadService } from './review-thread.service';
import { TransactionReviewService } from './transaction-review.service';
import { ReviewExportService } from './review-export.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Threads, attachments, the recurring-error figures and the two exports.
 *
 * The parts worth pinning down are the ones that would be quiet if they broke: the first-response
 * stamp (written once, by the agent only), the access check on a thread reachable by id, and the
 * grouping that makes the "most common reasons" chart mean anything.
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

const stubs = () => ({
  mailer: { send: async () => {} },
  settings: { current: async () => ({ name: 'Test Brokerage' }) },
  messages: { post: async () => [] },
});

const threadFor = (tx: PrismaService) => new ReviewThreadService(tx);
const reviewsFor = (tx: PrismaService) => {
  const s = stubs();
  return new TransactionReviewService(tx, s.mailer as never, s.settings as never, s.messages as never);
};

async function makeTxn(tx: PrismaService, agent = 'Test Agent'): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: { trade_no: `TH-${Date.now()}-${seq}`, type: 'Residential Buying', agent, property: '1 Test Road', company_id: 1, created_at: now, updated_at: now },
  });
  return t.id;
}

async function makeReview(tx: PrismaService, txnId: number, over: Record<string, unknown> = {}) {
  const now = new Date();
  return tx.transaction_reviews.create({
    data: {
      transaction_id: txnId, decision: 'Rejected', reason: 'Does not match the APS.',
      field_label: 'Purchase Price', old_value: '1', new_value: '2', agent_name: 'Test Agent',
      actor_name: 'Office Admin', resolution_status: 'Open', company_id: 1,
      created_at: now, updated_at: now, ...over,
    },
  });
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('the discussion on a review item', () => {
  it('records a reply with its author and role', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      const review = await makeReview(tx, txnId);
      const messages = await threadFor(tx).post(ADMIN, review.id, 'Please check the APS page 2.');

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ author: 'Office Admin', author_role: 'admin', body: 'Please check the APS page 2.' });
    });
  });

  it('stamps the first response when the AGENT replies, and never moves it', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      const review = await makeReview(tx, txnId);
      const thread = threadFor(tx);

      // The office answering its own rejection is not the thing being measured.
      await thread.post(ADMIN, review.id, 'Any update?');
      expect((await tx.transaction_reviews.findUnique({ where: { id: review.id } }))?.first_response_at).toBeNull();

      await thread.post(AGENT, review.id, 'Fixing it now.');
      const first = (await tx.transaction_reviews.findUnique({ where: { id: review.id } }))?.first_response_at;
      expect(first).toBeTruthy();

      await thread.post(AGENT, review.id, 'Done.');
      expect((await tx.transaction_reviews.findUnique({ where: { id: review.id } }))?.first_response_at).toEqual(first);
    });
  });

  it('counts a correction as the response when no reply came first', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      const review = await makeReview(tx, txnId);
      await reviewsFor(tx).markCorrected(txnId, 'Test Agent', ['Purchase Price']);

      const after = await tx.transaction_reviews.findUnique({ where: { id: review.id } });
      expect(after?.first_response_at).toBeTruthy();
      expect(after?.resolution_status).toBe('Corrected');
    });
  });

  it('refuses an empty post, and accepts one that is only a file', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      const review = await makeReview(tx, txnId);
      const thread = threadFor(tx);

      await expect(thread.post(ADMIN, review.id, '   ')).rejects.toThrow(/cannot be empty|attach a file/i);

      const messages = await thread.post(ADMIN, review.id, '', [{ filename: 'shot.png', content_type: 'image/png', data: b64('not-really-a-png') }]);
      expect(messages[0].attachments).toHaveLength(1);
      expect((messages[0].attachments as { filename: string }[])[0].filename).toBe('shot.png');
    });
  });

  it('will not let an agent read another agent’s thread', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx, 'Someone Else');
      const review = await makeReview(tx, txnId);
      await expect(threadFor(tx).list(AGENT, review.id)).rejects.toThrow(/do not have access/i);
    });
  });

  it('serves an attachment back, behind the same check', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      const review = await makeReview(tx, txnId);
      const thread = threadFor(tx);
      const messages = await thread.post(ADMIN, review.id, 'See attached', [{ filename: 'aps.pdf', content_type: 'application/pdf', data: b64('%PDF-1.4 fake') }]);
      const attachmentId = (messages[0].attachments as { id: number }[])[0].id;

      const file = await thread.attachment(ADMIN, attachmentId);
      expect(file.filename).toBe('aps.pdf');
      expect(file.data.toString()).toContain('%PDF-1.4');
    });
  });
});

describe('recurring errors', () => {
  it('ranks the fields rejected most often', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      await makeReview(tx, txnId, { field_label: 'Purchase Price' });
      await makeReview(tx, txnId, { field_label: 'Purchase Price' });
      await makeReview(tx, txnId, { field_label: 'Closing Date' });

      const out = await reviewsFor(tx).recurringErrors(ADMIN) as { by_field: { name: string; count: number }[] };
      expect(out.by_field[0]).toEqual({ name: 'Purchase Price', count: 2 });
      expect(out.by_field[1]).toEqual({ name: 'Closing Date', count: 1 });
    });
  });

  it('groups the same complaint typed differently', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      await makeReview(tx, txnId, { reason: "Doesn't match the APS." });
      await makeReview(tx, txnId, { reason: 'doesnt match the aps' });
      await makeReview(tx, txnId, { reason: 'Missing signature.' });

      const out = await reviewsFor(tx).recurringErrors(ADMIN) as { by_reason: { name: string; count: number }[] };
      // Two spellings of one complaint, counted once — otherwise the chart is a list of
      // near-identical sentences with a count of one each.
      expect(out.by_reason[0].count).toBe(2);
      expect(out.by_reason.map((r) => r.count)).toEqual([2, 1]);
    });
  });

  it('reports first-response and correction time, median beside mean', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      const raised = new Date(Date.now() - 10 * 3600_000);
      await makeReview(tx, txnId, {
        created_at: raised,
        first_response_at: new Date(raised.getTime() + 2 * 3600_000),
        corrected_at: new Date(raised.getTime() + 6 * 3600_000),
      });

      const out = await reviewsFor(tx).recurringErrors(ADMIN) as {
        first_response: { average_hours: number; median_hours: number };
        correction_time: { average_hours: number; median_hours: number };
      };
      expect(out.first_response.average_hours).toBe(2);
      expect(out.first_response.median_hours).toBe(2);
      expect(out.correction_time.average_hours).toBe(6);
    });
  });
});

describe('exporting the history', () => {
  const exportFor = (tx: PrismaService) =>
    new ReviewExportService(tx, { current: async () => ({ name: 'Test Brokerage' }) } as never, reviewsFor(tx));

  it('produces a real spreadsheet', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      await makeReview(tx, txnId);
      const file = await exportFor(tx).xlsx(ADMIN, txnId, {});
      // XLSX is a zip: "PK" is the signature every reader looks for.
      expect(file.buffer.subarray(0, 2).toString()).toBe('PK');
      expect(file.filename).toMatch(/^Review History - TH-.*\.xlsx$/);
    });
  });

  it('produces a real PDF', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      await makeReview(tx, txnId);
      const file = await exportFor(tx).pdf(ADMIN, txnId, {});
      expect(file.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(file.filename).toMatch(/\.pdf$/);
    });
  });

  it('exports what the filter selected, not everything', async () => {
    await inRollback(async (tx) => {
      const txnId = await makeTxn(tx);
      await makeReview(tx, txnId, { field_label: 'Purchase Price' });
      await makeReview(tx, txnId, { field_label: 'Closing Date' });

      const all = await exportFor(tx).xlsx(ADMIN, txnId, {});
      const one = await exportFor(tx).xlsx(ADMIN, txnId, { field: 'closing' });
      // A filtered export is a smaller file; the point is that the filter reached the export at all.
      expect(one.buffer.length).toBeLessThan(all.buffer.length);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
