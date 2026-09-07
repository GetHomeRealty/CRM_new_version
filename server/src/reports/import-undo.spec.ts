import { PrismaClient } from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionImportService } from './transaction-import.service';
import type { TransactionsWriteService } from '../transactions/transactions-write.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * TD-142 — one import, one action to put it back.
 *
 * AN IMPORT CAN CREATE HUNDREDS OF DEALS IN ONE PRESS and could only be reversed a deal at a time:
 * the trash icon on each row, then Delete forever in the Recycle Bin — roughly a thousand
 * deliberate clicks for the 495 historic deals the brokerage intends to migrate, or SQL against
 * production. Reversing a mistake cost more than making it.
 *
 * THE ENTRY'S PREMISE WAS WRONG, and that is why this carries a migration. It says "the batch id is
 * already stored against every row it created", and it was not: `import_batches` recorded the
 * batch and nothing on the transaction pointed back at it. `import_batch_id` is the link, stamped
 * by `confirm` on every row it writes.
 *
 * BATCH RATHER THAN SELECTION, which the entry offers as the better of its two options and is: a
 * batch cannot catch a deal somebody entered by hand in between, and it asks no judgement at the
 * moment of use. A bulk delete over whatever happens to be selected is a more dangerous control.
 *
 * Real rows in rolled-back transactions — this removes records, so a stub would prove nothing about
 * what it removes.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const superAdmin = { id: 1, name: 'Akhil', role: 'admin' } as unknown as AuthUserRecord;
const agent = { id: 2, name: 'Sai Ramesh', role: 'agent' } as unknown as AuthUserRecord;

/**
 * The service under test batches its writes with `prisma.$transaction([...])`, which is right: the
 * deals and their invoices must move together or not at all, or a failure between the two leaves
 * invoices pointing at a deal that is no longer there.
 *
 * Prisma refuses a nested interactive transaction, so the client handed in here answers
 * `$transaction` by running the operations in order. That is not a weakening — we are ALREADY
 * inside a transaction that the harness rolls back, so the outer one supplies exactly the
 * atomicity the inner one was asking for.
 */
const serviceFor = (tx: PrismaService): TransactionImportService => {
  const client = new Proxy(tx as unknown as Record<string, unknown>, {
    get: (target, prop) => (prop === '$transaction'
      ? async (ops: Promise<unknown>[]) => { const out = []; for (const op of ops) out.push(await op); return out; }
      : target[prop as string]),
  }) as unknown as PrismaService;
  return new TransactionImportService(client, {} as unknown as TransactionsWriteService);
};

async function makeBatch(tx: PrismaService, batchId: string, status = 'Imported'): Promise<void> {
  const now = new Date();
  await tx.import_batches.create({
    data: {
      batch_id: batchId, file_name: 'historic-deals.xlsx', uploaded_by: 'Akhil', uploaded_at: now,
      total_rows: 3, valid_rows: 3, imported_rows: 3, status, created_at: now, updated_at: now,
    },
  });
}

async function makeDeal(tx: PrismaService, over: Record<string, unknown> = {}): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `TD142-${Date.now()}-${seq}`, type: 'Residential Buying', property: '3 Batch Road',
      agent: 'Sai Ramesh', created_at: now, updated_at: now, ...over,
    },
  });
  return t.id;
}

const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    throw new Error('expected the undo to be refused');
  } catch (e) {
    if (e instanceof BadRequestException || e instanceof NotFoundException) {
      return (e.getResponse() as { message: string }).message;
    }
    throw e;
  }
};

describe('undoing one bulk import (TD-142)', () => {
  it('moves every deal that import made to the Recycle Bin, in one action', async () => {
    await inRollback(async (tx) => {
      const batchId = `IMP-${Date.now()}-A`;
      await makeBatch(tx, batchId);
      for (let i = 0; i < 3; i++) await makeDeal(tx, { import_batch_id: batchId });

      const r = await serviceFor(tx).undo(batchId, superAdmin) as { removed: number };

      expect(r.removed).toBe(3);
      // Soft-deleted, not gone: the Recycle Bin is what makes the undo itself undoable.
      const left = await tx.transactions.count({ where: { import_batch_id: batchId, deleted_at: null } });
      const binned = await tx.transactions.count({ where: { import_batch_id: batchId, deleted_at: { not: null } } });
      expect([left, binned]).toEqual([0, 3]);
    });
  }, 60000);

  it('does not touch a deal somebody entered by hand', async () => {
    // The reason the entry prefers the batch over a bulk delete on the selection.
    await inRollback(async (tx) => {
      const batchId = `IMP-${Date.now()}-B`;
      await makeBatch(tx, batchId);
      await makeDeal(tx, { import_batch_id: batchId });
      const byHand = await makeDeal(tx);

      await serviceFor(tx).undo(batchId, superAdmin);

      const kept = await tx.transactions.findUnique({ where: { id: byHand } });
      expect(kept?.deleted_at).toBeNull();
    });
  }, 60000);

  it('does not touch a different import', async () => {
    await inRollback(async (tx) => {
      const mine = `IMP-${Date.now()}-C`;
      const other = `IMP-${Date.now()}-D`;
      await makeBatch(tx, mine);
      await makeBatch(tx, other);
      await makeDeal(tx, { import_batch_id: mine });
      const otherDeal = await makeDeal(tx, { import_batch_id: other });

      await serviceFor(tx).undo(mine, superAdmin);

      expect((await tx.transactions.findUnique({ where: { id: otherDeal } }))?.deleted_at).toBeNull();
    });
  }, 60000);

  it('takes the invoices with the deals, stamped at the same moment', async () => {
    /*
     * The same pairing a single delete makes, and for the same reason: an invoice left behind stays
     * on the Invoice screen pointing at a deal that is not there. One timestamp on both is what
     * lets a restore bring back exactly the invoices that went with them.
     */
    await inRollback(async (tx) => {
      const batchId = `IMP-${Date.now()}-E`;
      await makeBatch(tx, batchId);
      const dealId = await makeDeal(tx, { import_batch_id: batchId });
      const now = new Date();
      await tx.invoices.create({
        data: {
          transaction_id: dealId, invoice_no: `ZZ-U-${Date.now()}`, status: 'Unpaid',
          invoice_date: new Date('2026-06-01T00:00:00.000Z'), created_at: now, updated_at: now,
        },
      });

      await serviceFor(tx).undo(batchId, superAdmin);

      const deal = await tx.transactions.findUnique({ where: { id: dealId } });
      const inv = await tx.invoices.findFirst({ where: { transaction_id: dealId } });
      expect(inv?.deleted_at).not.toBeNull();
      expect(inv?.deleted_at?.getTime()).toBe(deal?.deleted_at?.getTime());
    });
  }, 60000);

  it('marks the batch undone, so it cannot be undone twice', async () => {
    await inRollback(async (tx) => {
      const batchId = `IMP-${Date.now()}-F`;
      await makeBatch(tx, batchId);
      await makeDeal(tx, { import_batch_id: batchId });
      const svc = serviceFor(tx);

      await svc.undo(batchId, superAdmin);

      expect((await tx.import_batches.findUnique({ where: { batch_id: batchId } }))?.status).toBe('Undone');
      expect(await refusal(() => svc.undo(batchId, superAdmin))).toContain('Only a completed import');
    });
  }, 60000);

  it('leaves a deal deleted earlier with its own moment', async () => {
    // Re-stamping it would fold it into this undo's restore and take away the one it already had.
    await inRollback(async (tx) => {
      const batchId = `IMP-${Date.now()}-G`;
      await makeBatch(tx, batchId);
      const earlier = new Date('2026-08-01T09:00:00.000Z');
      const gone = await makeDeal(tx, { import_batch_id: batchId, deleted_at: earlier });
      await makeDeal(tx, { import_batch_id: batchId });

      const r = await serviceFor(tx).undo(batchId, superAdmin) as { removed: number };

      expect(r.removed).toBe(1);
      expect((await tx.transactions.findUnique({ where: { id: gone } }))?.deleted_at?.getTime()).toBe(earlier.getTime());
    });
  }, 60000);
});

describe('what the undo refuses (TD-142)', () => {
  it('refuses an import that was never completed', async () => {
    await inRollback(async (tx) => {
      const batchId = `IMP-${Date.now()}-H`;
      await makeBatch(tx, batchId, 'Validated');
      expect(await refusal(() => serviceFor(tx).undo(batchId, superAdmin))).toContain('Only a completed import');
    });
  }, 60000);

  it('says plainly that an older import carries no batch to reverse', async () => {
    // Every deal created before this column exists carries null, so nothing records which import
    // made it. Saying so beats a silent success that removes nothing.
    await inRollback(async (tx) => {
      const batchId = `IMP-${Date.now()}-I`;
      await makeBatch(tx, batchId);
      await makeDeal(tx); // no batch id — as every pre-existing row has

      const message = await refusal(() => serviceFor(tx).undo(batchId, superAdmin));
      expect(message).toContain('Nothing to undo');
      expect(message).toContain('carry no batch');
    });
  }, 60000);

  it('refuses a batch that does not exist', async () => {
    await inRollback(async (tx) => {
      expect(await refusal(() => serviceFor(tx).undo('IMP-NOPE', superAdmin))).toContain('not found');
    });
  }, 60000);

  it('is closed to anyone who could not have run the import', async () => {
    // Same door as the import itself: whoever may create hundreds of deals in one press is exactly
    // who may put them back.
    await inRollback(async (tx) => {
      const batchId = `IMP-${Date.now()}-J`;
      await makeBatch(tx, batchId);
      await makeDeal(tx, { import_batch_id: batchId });

      await expect(serviceFor(tx).undo(batchId, agent)).rejects.toThrow(/permission/i);
      expect(await tx.transactions.count({ where: { import_batch_id: batchId, deleted_at: null } })).toBe(1);
    });
  }, 60000);
});
