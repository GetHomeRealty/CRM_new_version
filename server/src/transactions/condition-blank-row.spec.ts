import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionsWriteService } from './transactions-write.service';
import { DocumentsService } from '../documents/documents.service';

/**
 * TD-065 — a blank condition row is not a condition, and never becomes a document.
 *
 * THE DEFECT. The Conditional Offer editor keeps a spare row for the next entry, and the whole
 * list was sent on save. One condition entered arrived as two: the real one, and
 * `{type: '', deadline: null, status: 'Pending'}`. The blank one stored, and the document
 * auto-creation gave it a checklist row titled literally "Condition: " — an outstanding document
 * nobody could satisfy, counted in the deal's Documents Outstanding and printed on a RECO file.
 *
 * BOTH HALVES ARE ASSERTED, because the browser is not the only caller. `syncConditions` drops a
 * row that names nothing, so an import or an integration sending the same shape cannot store one;
 * and `syncConditionDocs` refuses to title a document after a condition with no name, which also
 * disposes of the ones already stored by the original defect.
 *
 * WHAT MUST NOT CHANGE. A condition named only by `custom_name` is a real condition — it takes the
 * long-standing 'Financing' default for its type rather than being mistaken for a blank row — and
 * the deletion path stays as TD-120 left it: a document carrying an upload is soft-deleted to the
 * Recycle Bin, never destroyed.
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

/** Both services reach the database through the handed-in client; nothing else is used here. */
const writer = new TransactionsWriteService(
  ...(Array.from({ length: 10 }, () => ({})) as unknown as ConstructorParameters<typeof TransactionsWriteService>),
);
const syncConditions = (tx: PrismaService, txnId: number, rows: Record<string, unknown>[]): Promise<void> =>
  (writer as unknown as { syncConditions(t: PrismaService, id: number, r: Record<string, unknown>[]): Promise<void> })
    .syncConditions(tx, txnId, rows);

const syncConditionDocs = (tx: PrismaService, txn: { id: number; conditional_offer: boolean }): Promise<void> => {
  const docs = new DocumentsService(
    ...(Array.from({ length: 9 }, () => ({})) as unknown as ConstructorParameters<typeof DocumentsService>),
  );
  (docs as unknown as { prisma: PrismaService }).prisma = tx;
  return (docs as unknown as { syncConditionDocs(t: { id: number; conditional_offer: boolean }): Promise<void> })
    .syncConditionDocs(txn);
};

async function deal(tx: PrismaService) {
  const now = new Date();
  return tx.transactions.create({
    data: {
      trade_no: `TD065-${Date.now()}-${++seq}`, type: 'Residential Buying', property: '1 Condition Way',
      conditional_offer: true, adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
      created_at: now, updated_at: now,
    },
    select: { id: true, conditional_offer: true },
  });
}

const titles = async (tx: PrismaService, txnId: number): Promise<string[]> =>
  (await tx.documents.findMany({ where: { transaction_id: txnId, deleted_at: null }, orderBy: { id: 'asc' }, select: { title: true } }))
    .map((d) => d.title);

describe('a blank condition row is not saved (TD-065)', () => {
  it('stores one condition when the form sends one plus its spare row', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      // Exactly what the editor sent: the entered condition, then the row offered for the next one.
      await syncConditions(tx, t.id, [
        { type: 'Home Inspection', custom_name: null, deadline: '2026-09-20', status: 'Pending' },
        { type: '', custom_name: null, deadline: null, status: 'Pending' },
      ]);

      const rows = await tx.conditions.findMany({ where: { transaction_id: t.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('Home Inspection');
    });
  });

  it('keeps a condition that is named only by its custom name', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await syncConditions(tx, t.id, [{ custom_name: 'Well water test', deadline: null, status: 'Pending' }]);

      const rows = await tx.conditions.findMany({ where: { transaction_id: t.id } });
      expect(rows).toHaveLength(1);
      expect([rows[0].custom_name, rows[0].type]).toEqual(['Well water test', 'Financing']);
    });
  });

  it('drops a stored condition whose name has been cleared, rather than keeping a nameless one', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      await syncConditions(tx, t.id, [{ type: 'Financing', custom_name: null, deadline: null, status: 'Pending' }]);
      const [stored] = await tx.conditions.findMany({ where: { transaction_id: t.id } });

      await syncConditions(tx, t.id, [{ id: stored.id, type: '', custom_name: '', deadline: null, status: 'Pending' }]);
      expect(await tx.conditions.findMany({ where: { transaction_id: t.id } })).toHaveLength(0);
    });
  });
});

describe('a condition with no name produces no document (TD-065)', () => {
  it('titles the real one and creates nothing for a nameless row', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const now = new Date();
      // A nameless condition already in the database — what the original defect stored.
      await tx.conditions.createMany({
        data: [
          { transaction_id: t.id, type: 'Home Inspection', status: 'Pending', position: 0, created_at: now, updated_at: now },
          { transaction_id: t.id, type: '', status: 'Pending', position: 1, created_at: now, updated_at: now },
        ],
      });

      await syncConditionDocs(tx, t);

      const list = await titles(tx, t.id);
      expect(list).toEqual(['Condition: Home Inspection']);
      expect(list.some((x) => x.trim() === 'Condition:')).toBe(false);
    });
  });

  it('clears a "Condition: " row the old behaviour already created', async () => {
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const now = new Date();
      const nameless = await tx.conditions.create({
        data: { transaction_id: t.id, type: '', status: 'Pending', position: 0, created_at: now, updated_at: now },
      });
      await tx.documents.create({
        data: {
          transaction_id: t.id, title: 'Condition: ', is_condition: true, condition_id: nameless.id,
          position: 1, created_at: now, updated_at: now,
        },
      });

      await syncConditionDocs(tx, t);
      expect(await titles(tx, t.id)).toEqual([]);
    });
  });

  it('does not destroy a nameless condition\'s document when a file was uploaded against it', async () => {
    // TD-120's rule, which this must not undo: anything carrying an upload is soft-deleted so it
    // reaches the Recycle Bin.
    await inRollback(async (tx) => {
      const t = await deal(tx);
      const now = new Date();
      const nameless = await tx.conditions.create({
        data: { transaction_id: t.id, type: '', status: 'Pending', position: 0, created_at: now, updated_at: now },
      });
      const doc = await tx.documents.create({
        data: {
          transaction_id: t.id, title: 'Condition: ', is_condition: true, condition_id: nameless.id,
          file_path: 'uploads/zz-test.pdf', file_name: 'zz-test.pdf',
          position: 1, created_at: now, updated_at: now,
        },
      });

      await syncConditionDocs(tx, t);

      const after = await tx.documents.findUnique({ where: { id: doc.id }, select: { deleted_at: true, file_path: true } });
      expect(after?.deleted_at).not.toBeNull();
      expect(after?.file_path).toBe('uploads/zz-test.pdf');
    });
  });
});
