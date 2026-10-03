import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { DocumentsService } from './documents.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { DOC } from './checklist-definitions';

/**
 * THE BROKERAGE'S PAPERWORK REACHES THE AGENT WHEN IT IS READY, AND NOT BEFORE.
 *
 * Sai ruled this on 2026-10-03. The Deposit Receipt, Notice of Sale and Trade Record Sheet are
 * prepared by the admin team from the lawyer details the agent fills in, and raised to the agent
 * for signing - TD-116, settled 2026-09-23. Until then the agent was shown an empty upload box for
 * each of them, on 890 deals, with 1,435 mandatory rows counting against their own figures.
 *
 * "The notice of sale will appear automatically in the agent's docs when the signings are
 * completed" - and it does: NoticeOfSaleService marks that row Received when the brokerage sends
 * it. So this is not a hidden document. It is a document that is not the agent's to supply.
 *
 * THE ROW IS NEVER REMOVED, which is the brokerage's standing rule of 2026-09-25. Admin sees all
 * three on every deal, counted exactly as before.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const AGENT_ID = 990002;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (String((e as Error).message).includes(ROLLBACK) === false) throw e;
  }
}

const theAgent = { id: AGENT_ID, name: 'Paperwork Agent', role: 'agent', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;
const theAdmin = { id: 1, name: 'Paperwork Admin', role: 'admin', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;

const serviceFor = (tx: PrismaService) => new DocumentsService(
  {} as never, tx,
  { record: async () => undefined } as never,
  { sync: async () => undefined } as never,
  {} as never, {} as never, {} as never,
);

async function deal(tx: PrismaService) {
  const now = new Date();
  return tx.transactions.create({ data: {
    trade_no: `BROKDOC-${Date.now()}-${++seq}`, type: 'Residential Listing',
    agent: 'Paperwork Agent', agent_user_id: AGENT_ID, price: 500000,
    comm_type: '%', comm_value: 0, comm_pct: 2.5, comm_status: 'Pending', comm_paid_status: 'No',
    closing_date: new Date('2025-06-15T00:00:00.000Z'), offer_date: new Date('2025-03-01T00:00:00.000Z'),
    adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
  } });
}

const doc = (tx: PrismaService, txnId: number, over: Record<string, unknown>) => {
  const now = new Date();
  return tx.documents.create({ data: {
    transaction_id: txnId, title: 'A document', mandatory: true, manual: false,
    status: 'Pending', validation: 'Pending', position: 1, created_at: now, updated_at: now, ...over,
  } as never });
};

type Seen = { documents: { title: string }[]; stats: { total: number; mandatory: number } };
const seenBy = async (tx: PrismaService, txnId: number, who: AuthUserRecord): Promise<Seen> =>
  await serviceFor(tx).payload(txnId, who as never) as unknown as Seen;
const titles = (s: Seen) => s.documents.map((d) => d.title);

describe('the brokerage prepares it, the agent sees it once it is ready', () => {
  jest.setTimeout(60_000);

  it('does NOT show the agent an empty Notice of Sale, and does not count it against them', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await doc(tx, t.id, { title: DOC.APS, position: 1 });
      await doc(tx, t.id, { title: DOC.NOS, position: 2 });
      const agentSees = await seenBy(tx, t.id, theAgent);
      expect(titles(agentSees)).toEqual([DOC.APS]);
      expect(agentSees.stats.total).toBe(1);
      expect(agentSees.stats.mandatory).toBe(1);
    });
  });

  it('SHOWS the agent the same document the moment the brokerage produces it', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await doc(tx, t.id, { title: DOC.NOS, status: 'Received' });
      expect(titles(await seenBy(tx, t.id, theAgent))).toEqual([DOC.NOS]);
    });
  });

  it('shows it to the agent when a file is attached, whatever the status says', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await doc(tx, t.id, { title: DOC.TRADE_SHEET, file_path: 'documents/x.pdf' });
      expect(titles(await seenBy(tx, t.id, theAgent))).toEqual([DOC.TRADE_SHEET]);
    });
  });

  it('NEVER hides a document somebody added by hand, whatever it is called', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await doc(tx, t.id, { title: DOC.DEPOSIT_RECEIPT, manual: true });
      expect(titles(await seenBy(tx, t.id, theAgent))).toEqual([DOC.DEPOSIT_RECEIPT]);
    });
  });

  it('changes NOTHING for the brokerage: admin sees all three, empty or not', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await doc(tx, t.id, { title: DOC.APS, position: 1 });
      await doc(tx, t.id, { title: DOC.NOS, position: 2 });
      await doc(tx, t.id, { title: DOC.TRADE_SHEET, position: 3 });
      await doc(tx, t.id, { title: DOC.DEPOSIT_RECEIPT, position: 4 });
      const adminSees = await seenBy(tx, t.id, theAdmin);
      expect(titles(adminSees)).toEqual([DOC.APS, DOC.NOS, DOC.TRADE_SHEET, DOC.DEPOSIT_RECEIPT]);
      expect(adminSees.stats.total).toBe(4);
      expect(adminSees.stats.mandatory).toBe(4);
    });
  });
});
