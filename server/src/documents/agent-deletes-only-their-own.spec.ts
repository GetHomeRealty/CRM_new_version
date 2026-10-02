import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { DocumentsService } from './documents.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * AN AGENT MAY REMOVE A DOCUMENT THEY ADDED, AND NOTHING ELSE.
 *
 * Sai ruled this on 2026-10-02, once "+ Add document" made adding easy: an agent who mistyped a
 * name had no way to undo it. Every delete was refused for an agent before that.
 *
 * The rule is narrow on purpose, and this file is what holds it narrow. The screen hides the
 * control on rows an agent may not touch, but the screen is only a reflection - these cases are
 * against the service, which is what a request actually reaches.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const AGENT_ID = 990001;

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

const theAgent = { id: AGENT_ID, name: 'Doc Agent', role: 'agent', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;

/** destroy() reaches only prisma, audit.record and docsValidation.sync; the rest are never called. */
const serviceFor = (tx: PrismaService) => new DocumentsService(
  {} as never, tx,
  { record: async () => undefined } as never,
  { sync: async () => undefined } as never,
  {} as never, {} as never, {} as never,
);

async function deal(tx: PrismaService) {
  const now = new Date();
  return tx.transactions.create({ data: {
    trade_no: `DOCDEL-${Date.now()}-${++seq}`, type: 'Residential Buying',
    agent: 'Doc Agent', agent_user_id: AGENT_ID, price: 500000,
    comm_type: '%', comm_value: 0, comm_pct: 2.5, comm_status: 'Pending', comm_paid_status: 'No',
    closing_date: new Date('2025-06-15T00:00:00.000Z'), offer_date: new Date('2025-03-01T00:00:00.000Z'),
    adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
  } });
}

const doc = (tx: PrismaService, txnId: number, over: Record<string, unknown>) => {
  const now = new Date();
  return tx.documents.create({ data: {
    transaction_id: txnId, title: 'A document', mandatory: false, manual: true,
    status: 'Pending', validation: 'Pending', position: 1, created_at: now, updated_at: now, ...over,
  } as never });
};

describe('an agent may delete only a document they added', () => {
  jest.setTimeout(60_000);

  it('REMOVES one they added that holds no file', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const d = await doc(tx, t.id, { title: 'Typed the name wrong' });
      await serviceFor(tx).destroy(theAgent, d.id);
      const after = await tx.documents.findUnique({ where: { id: d.id } });
      expect(after?.deleted_at).not.toBeNull();
    });
  });

  it('REFUSES one the system put there', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const d = await doc(tx, t.id, { title: 'Agreement of Purchase and Sale (APS)', manual: false });
      await expect(serviceFor(tx).destroy(theAgent, d.id)).rejects.toThrow(/only remove a document you added yourself/);
      const after = await tx.documents.findUnique({ where: { id: d.id } });
      expect(after?.deleted_at).toBeNull();
    });
  });

  it('REFUSES their own once a file is on it', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const d = await doc(tx, t.id, { title: 'Mine, with evidence', file_name: 'x.pdf', file_path: 'documents/1/x.pdf' });
      await expect(serviceFor(tx).destroy(theAgent, d.id)).rejects.toThrow(/no file on it/);
      const after = await tx.documents.findUnique({ where: { id: d.id } });
      expect(after?.deleted_at).toBeNull();
    });
  });

  it('REFUSES one on somebody else deal, even if hand-added and empty', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await tx.transactions.update({ where: { id: t.id }, data: { agent_user_id: AGENT_ID + 1, agent: 'Someone Else' } });
      const d = await doc(tx, t.id, { title: 'Not theirs' });
      await expect(serviceFor(tx).destroy(theAgent, d.id)).rejects.toThrow(/do not have access/);
    });
  });
});
