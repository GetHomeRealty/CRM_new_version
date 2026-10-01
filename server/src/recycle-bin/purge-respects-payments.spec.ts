import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { RecycleBinService } from './recycle-bin.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * A DEAL CANNOT BE ERASED OUT FROM UNDER A PAYMENT.
 *
 * Deleting an INVOICE that holds a payment has been refused since TD-162. Permanently deleting the
 * DEAL never consulted that rule: transactions -> invoices -> invoice_payments are CASCADE in the
 * database, so the deal, its invoices and every payment row went in one statement with nothing
 * asking first.
 *
 * MEASURED BEFORE THE GUARD WAS WRITTEN, 2026-09-30: no trashed deal held a paid invoice and no
 * trashed invoice held a live payment. Nothing had slipped through - this closes the door before
 * anyone walks through it, which is why the third case below matters as much as the first.
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

const superAdmin: AuthUserRecord = { id: 1, name: 'Bin Admin', role: 'admin', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;

/** Only the database is reached on this path; the other three dependencies are never touched. */
const serviceFor = (tx: PrismaService) => new RecycleBinService(tx, {} as never, {} as never, {} as never);

async function trashedDeal(tx: PrismaService, withPayment: boolean): Promise<{ id: number; invoiceId: number }> {
  const now = new Date();
  const n = ++seq;
  const t = await tx.transactions.create({
    data: {
      trade_no: `BIN-${Date.now()}-${n}`, type: 'Residential Buying', agent: 'Bin Agent',
      price: 500000, comm_type: '%', comm_value: 0, comm_pct: 2.5,
      comm_status: 'Pending', comm_paid_status: 'No',
      closing_date: new Date('2025-06-15T00:00:00.000Z'), offer_date: new Date('2025-03-01T00:00:00.000Z'),
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
      deleted_at: now, created_at: now, updated_at: now,
    },
  });
  const inv = await tx.invoices.create({
    data: { transaction_id: t.id, invoice_no: `ZZ-BIN-${Date.now()}-${n}`, status: 'Unpaid', invoice_date: now, created_at: now, updated_at: now },
  });
  if (withPayment) {
    await tx.invoice_payments.create({ data: { invoice_id: inv.id, amount: 1000, paid_on: now, created_at: now, updated_at: now } });
  }
  return { id: t.id, invoiceId: inv.id };
}

describe('permanently deleting a deal respects the payment guard', () => {
  jest.setTimeout(60_000);

  it('REFUSES a deal whose invoice holds a payment, and leaves the deal in place', async () => {
    await inRollback(async (tx) => {
      const { id } = await trashedDeal(tx, true);
      await expect(serviceFor(tx).forceDeleteTransaction(superAdmin, id))
        .rejects.toThrow(/payment recorded against it/);
      expect(await tx.transactions.count({ where: { id } })).toBe(1);
    });
  });

  it('still deletes a deal that carries no payment', async () => {
    await inRollback(async (tx) => {
      const { id } = await trashedDeal(tx, false);
      await serviceFor(tx).forceDeleteTransaction(superAdmin, id);
      expect(await tx.transactions.count({ where: { id } })).toBe(0);
    });
  });

  it('is not fooled by a payment that has itself been removed', async () => {
    await inRollback(async (tx) => {
      const { id, invoiceId } = await trashedDeal(tx, true);
      await tx.invoice_payments.updateMany({ where: { invoice_id: invoiceId }, data: { deleted_at: new Date() } });
      await serviceFor(tx).forceDeleteTransaction(superAdmin, id);
      expect(await tx.transactions.count({ where: { id } })).toBe(0);
    });
  });
});
