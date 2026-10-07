import { UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RetentionService, RETENTION_MONTHS } from './retention.service';
import { RecycleBinService } from '../recycle-bin/recycle-bin.service';

/*
 * TD-162 - NOTHING THAT EMPTIES THE RECYCLE BIN MAY ERASE A RECORDED PAYMENT.
 *
 * The brokerage's rule (2026-09-09): an invoice with a recorded payment can be neither voided nor
 * deleted. Permanently deleting a DEAL by hand already refuses one (purge-respects-payments.spec).
 * Two other doors were still open, found by re-checking the carry-forward register on 2026-10-07:
 *
 *   1. the automatic six-month clean-up (RetentionService.sweep) deleted trashed deals and trashed
 *      invoices in bulk, and the database CASCADE took their payments with them, unasked;
 *   2. permanently deleting a trashed INVOICE from the Recycle Bin deleted its payments first.
 *
 * Real rows in a rolled-back transaction.
 */
const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (String((e as Error).message).includes(ROLLBACK) === false) throw e;
  }
}

const OLD = new Date(Date.now() - (RETENTION_MONTHS + 2) * 30 * 86400000);
const admin = { id: 1, name: 'Bin Admin', role: 'admin', user_permissions: [], user_modules: [] } as never;

async function deal(tx: PrismaService, trashed: boolean) {
  const n = ++seq;
  return tx.transactions.create({ data: {
    trade_no: `PNP-${Date.now()}-${n}`, type: 'Residential Buying', price: 500000,
    adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
    deleted_at: trashed ? OLD : null, created_at: OLD, updated_at: OLD,
  } });
}
async function invoice(tx: PrismaService, txnId: number, trashed: boolean, payment: 'live' | 'removed' | 'none') {
  const n = ++seq;
  const inv = await tx.invoices.create({ data: {
    transaction_id: txnId, invoice_no: `ZZ-PNP-${Date.now()}-${n}`, status: 'Unpaid', invoice_date: OLD,
    deleted_at: trashed ? OLD : null, created_at: OLD, updated_at: OLD,
  } });
  if (payment !== 'none') {
    await tx.invoice_payments.create({ data: {
      invoice_id: inv.id, amount: 1000, paid_on: OLD, created_at: OLD, updated_at: OLD,
      deleted_at: payment === 'removed' ? OLD : null,
    } });
  }
  return inv;
}

describe('the automatic clean-up never erases a recorded payment', () => {
  const was = process.env.DESK_RETENTION_ENABLED;
  beforeEach(() => { process.env.DESK_RETENTION_ENABLED = 'true'; });
  afterEach(() => { if (was === undefined) delete process.env.DESK_RETENTION_ENABLED; else process.env.DESK_RETENTION_ENABLED = was; });

  it('keeps an old trashed deal whose invoice holds a payment, and still clears one that does not', async () => {
    await inRollback(async (tx) => {
      const paidDeal = await deal(tx, true);
      const paidInv = await invoice(tx, paidDeal.id, false, 'live');
      const plainDeal = await deal(tx, true);
      await invoice(tx, plainDeal.id, false, 'none');

      await new RetentionService(tx, new AuditService(tx)).sweep();

      expect(await tx.transactions.findUnique({ where: { id: paidDeal.id } })).not.toBeNull();
      expect(await tx.invoice_payments.count({ where: { invoice_id: paidInv.id } })).toBe(1);
      expect(await tx.transactions.findUnique({ where: { id: plainDeal.id } })).toBeNull();
    });
  });

  it('keeps an old trashed invoice that holds a payment, and still clears one that does not', async () => {
    await inRollback(async (tx) => {
      const live = await deal(tx, false);
      const paid = await invoice(tx, live.id, true, 'live');
      const plain = await invoice(tx, live.id, true, 'none');

      await new RetentionService(tx, new AuditService(tx)).sweep();

      expect(await tx.invoices.findUnique({ where: { id: paid.id } })).not.toBeNull();
      expect(await tx.invoice_payments.count({ where: { invoice_id: paid.id } })).toBe(1);
      expect(await tx.invoices.findUnique({ where: { id: plain.id } })).toBeNull();
    });
  });

  it('is not fooled by a payment that was itself removed - that deal is cleared as before', async () => {
    await inRollback(async (tx) => {
      const d = await deal(tx, true);
      await invoice(tx, d.id, false, 'removed');
      await new RetentionService(tx, new AuditService(tx)).sweep();
      expect(await tx.transactions.findUnique({ where: { id: d.id } })).toBeNull();
    });
  });

  it('does not count the protected ones as due for removal in its plan', async () => {
    await inRollback(async (tx) => {
      const svc = new RetentionService(tx, new AuditService(tx));
      const before = (await svc.plan()).counts;
      const d = await deal(tx, true);
      await invoice(tx, d.id, true, 'live');
      const after = (await svc.plan()).counts;
      expect(after.trashed_transactions).toBe(before.trashed_transactions);
      expect(after.trashed_invoices).toBe(before.trashed_invoices);
    });
  });
});

describe('permanently deleting an invoice from the Recycle Bin', () => {
  const bin = (tx: PrismaService) => new RecycleBinService(tx, {} as never, {} as never, {} as never);

  it('refuses an invoice that holds a payment, and erases nothing', async () => {
    await inRollback(async (tx) => {
      const live = await deal(tx, false);
      const inv = await invoice(tx, live.id, true, 'live');
      const err = await bin(tx).forceDeleteInvoice(admin, inv.id).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(await tx.invoices.findUnique({ where: { id: inv.id } })).not.toBeNull();
      expect(await tx.invoice_payments.count({ where: { invoice_id: inv.id } })).toBe(1);
    });
  });

  it('still deletes one that holds no payment, or only a removed one', async () => {
    await inRollback(async (tx) => {
      const live = await deal(tx, false);
      const a = await invoice(tx, live.id, true, 'none');
      const b = await invoice(tx, live.id, true, 'removed');
      jest.spyOn(RecycleBinService.prototype as never, 'logAction' as never).mockResolvedValue(undefined as never);
      await bin(tx).forceDeleteInvoice(admin, a.id);
      await bin(tx).forceDeleteInvoice(admin, b.id);
      expect(await tx.invoices.findUnique({ where: { id: a.id } })).toBeNull();
      expect(await tx.invoices.findUnique({ where: { id: b.id } })).toBeNull();
    });
  });
});
