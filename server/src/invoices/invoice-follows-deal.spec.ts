import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionInvoiceService } from './transaction-invoice.service';
import { InvoiceCalculator } from './invoice.calculator';
import { InvoiceNumberService } from './invoice.numbers';
import { CommissionService } from '../transactions/commission.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';

/**
 * TD-083 — an unsent invoice follows the deal it bills for.
 *
 * THE DOCUMENT CONTRADICTED ITSELF, which is worse than being out of date. `purchase_price` is
 * derived at READ time from the joined deal, so it always showed the current price; the commission
 * lines are stored columns written once at generation. A deal repriced from 800,000 to 900,000 gave
 * a document stating a purchase price of 900,000 and charging commission worked out on 800,000 —
 * and anyone can check the arithmetic. Every roll-up built on invoices inherited it, so the
 * Dashboard's billed and outstanding figures reconciled to the invoices and were wrong by the same
 * amount.
 *
 * THE FIX THE ENTRY POINTS AT: "something already refreshes the invoice from the deal on save — it
 * just refreshes the wrong half. The commission lines need to travel with the price field that is
 * already travelling."
 *
 * THE GUARDS ARE THE INTERESTING PART. Updating a document the brokerage bills on is only
 * legitimate while it has not left the building, so the tests below spend most of their effort on
 * what must NOT be touched. The entry is explicit that a sent invoice is a credit-note conversation
 * rather than a quiet edit.
 *
 * Real rows in rolled-back transactions: a stub would prove the method runs, not that the money it
 * writes is right.
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

const serviceFor = (tx: PrismaService): TransactionInvoiceService =>
  new TransactionInvoiceService(
    new InvoiceNumberService(),
    new InvoiceCalculator(),
    new CommissionService(new PersonResolver(tx)),
    new AuditService(tx),
  );

/** A Residential Buying deal at `price` and `pct`, with its commission invoice generated. */
async function dealWithInvoice(tx: PrismaService, price: number, pct: number) {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `TD083-${Date.now()}-${seq}`, type: 'Residential Buying', property: '5 Reprice Road',
      agent: 'ZZ Test', price, comm_type: '%', comm_value: pct, comm_pct: pct,
      offer_date: new Date('2026-04-01T00:00:00.000Z'), created_at: now, updated_at: now,
    },
  });
  await tx.company_settings.upsert({
    where: { id: 1 },
    create: { id: 1, name: 'ZZ', default_tax_rate: 13, created_at: now, updated_at: now },
    update: {},
  });
  const [inv] = await serviceFor(tx).generate(tx as never, t.id, null);
  return { txnId: t.id, invoiceId: inv.id };
}

const invoice = async (tx: PrismaService, id: number) =>
  tx.invoices.findUniqueOrThrow({ where: { id } });

const reprice = (tx: PrismaService, txnId: number, price: number) =>
  tx.transactions.update({ where: { id: txnId }, data: { price } });

describe('an unsent, unpaid invoice follows the deal (TD-083)', () => {
  it('moves its commission when the deal is repriced', async () => {
    await inRollback(async (tx) => {
      const { txnId, invoiceId } = await dealWithInvoice(tx, 800_000, 2.5);
      expect(Number((await invoice(tx, invoiceId)).sub_total)).toBe(20_000);

      await reprice(tx, txnId, 900_000);
      const changed = await serviceFor(tx).refreshFromDeal(tx as never, txnId, null);

      expect(changed).toBe(1);
      const after = await invoice(tx, invoiceId);
      // 900,000 × 2.5% = 22,500, and the HST follows it rather than staying on the old base.
      expect(Number(after.sub_total)).toBe(22_500);
      expect(Number(after.tax_total)).toBe(2_925);
      expect(Number(after.total)).toBe(25_425);
    });
  }, 60000);

  it('moves it when the RATE changes, not only the price', async () => {
    // The 2026-09-04 re-test: 2.5% to 5% on 1,200,000, and the invoice did not move.
    await inRollback(async (tx) => {
      const { txnId, invoiceId } = await dealWithInvoice(tx, 1_200_000, 2.5);

      await tx.transactions.update({ where: { id: txnId }, data: { comm_value: 5, comm_pct: 5 } });
      await serviceFor(tx).refreshFromDeal(tx as never, txnId, null);

      expect(Number((await invoice(tx, invoiceId)).sub_total)).toBe(60_000);
    });
  }, 60000);

  it('records the correction, so the change is not silent either', async () => {
    await inRollback(async (tx) => {
      const { txnId } = await dealWithInvoice(tx, 800_000, 2.5);
      await reprice(tx, txnId, 900_000);

      await serviceFor(tx).refreshFromDeal(tx as never, txnId, { id: 1, name: 'QA' });

      const entry = await tx.audit_logs.findFirst({
        where: { transaction_id: txnId, action: 'Invoice commission updated' },
      });
      expect(entry).not.toBeNull();
      expect(entry?.old_value).toBe('20000.00');
      expect(entry?.new_value).toBe('22500.00');
    });
  }, 60000);

  it('does nothing when the commission has not moved', async () => {
    // Called on every financial save, so it must be quiet when there is nothing to correct — an
    // audit entry per save would bury the ones that matter.
    await inRollback(async (tx) => {
      const { txnId } = await dealWithInvoice(tx, 800_000, 2.5);

      expect(await serviceFor(tx).refreshFromDeal(tx as never, txnId, null)).toBe(0);
    });
  }, 60000);
});

describe('what an invoice update must never touch (TD-083)', () => {
  it('leaves a SENT invoice alone', async () => {
    // "Once it is out, a change is a credit note and a conversation, not a quiet edit."
    await inRollback(async (tx) => {
      const { txnId, invoiceId } = await dealWithInvoice(tx, 800_000, 2.5);
      await tx.invoices.update({ where: { id: invoiceId }, data: { sent_at: new Date() } });

      await reprice(tx, txnId, 900_000);
      expect(await serviceFor(tx).refreshFromDeal(tx as never, txnId, null)).toBe(0);
      expect(Number((await invoice(tx, invoiceId)).sub_total)).toBe(20_000);
    });
  }, 60000);

  it('leaves a PAID invoice alone', async () => {
    await inRollback(async (tx) => {
      const { txnId, invoiceId } = await dealWithInvoice(tx, 800_000, 2.5);
      await tx.invoices.update({ where: { id: invoiceId }, data: { status: 'Paid', amount_paid: 22_600 } });

      await reprice(tx, txnId, 900_000);
      expect(await serviceFor(tx).refreshFromDeal(tx as never, txnId, null)).toBe(0);
    });
  }, 60000);

  it('leaves a PART-PAID invoice alone even if its status was never moved', async () => {
    // The status filter and the amount check are deliberately both there: money on the invoice is
    // the fact that matters, and a part-payment recorded without moving the status must still stop
    // this.
    await inRollback(async (tx) => {
      const { txnId, invoiceId } = await dealWithInvoice(tx, 800_000, 2.5);
      await tx.invoices.update({ where: { id: invoiceId }, data: { amount_paid: 500 } });

      await reprice(tx, txnId, 900_000);
      expect(await serviceFor(tx).refreshFromDeal(tx as never, txnId, null)).toBe(0);
    });
  }, 60000);

  it('does not revive a VOID invoice', async () => {
    await inRollback(async (tx) => {
      const { txnId, invoiceId } = await dealWithInvoice(tx, 800_000, 2.5);
      await tx.invoices.update({ where: { id: invoiceId }, data: { status: 'Void' } });

      await reprice(tx, txnId, 900_000);
      expect(await serviceFor(tx).refreshFromDeal(tx as never, txnId, null)).toBe(0);
    });
  }, 60000);

  it('leaves an invoice somebody raised by hand alone', async () => {
    // Only the commission line this system wrote is ours to move. A hand-built invoice has no such
    // line, and rewriting the whole thing from the deal would delete somebody's work.
    await inRollback(async (tx) => {
      const { txnId } = await dealWithInvoice(tx, 800_000, 2.5);
      const now = new Date();
      const manual = await tx.invoices.create({
        data: {
          transaction_id: txnId, invoice_no: `ZZ-MANUAL-${Date.now()}`, source: 'manual',
          status: 'Unpaid', invoice_date: now, created_at: now, updated_at: now,
        },
      });
      await tx.invoice_line_items.create({
        data: { invoice_id: manual.id, row_no: 1, description: 'Marketing recharge', qty: 1, rate: 750, amount: 750, is_taxable: true, created_at: now, updated_at: now },
      });

      await reprice(tx, txnId, 900_000);
      await serviceFor(tx).refreshFromDeal(tx as never, txnId, null);

      const line = await tx.invoice_line_items.findFirstOrThrow({ where: { invoice_id: manual.id } });
      expect(Number(line.amount)).toBe(750);
      expect(line.description).toBe('Marketing recharge');
    });
  }, 60000);

  it('leaves a line somebody added to the generated invoice alone', async () => {
    await inRollback(async (tx) => {
      const { txnId, invoiceId } = await dealWithInvoice(tx, 800_000, 2.5);
      const now = new Date();
      await tx.invoice_line_items.create({
        data: { invoice_id: invoiceId, row_no: 2, description: 'Sign installation', qty: 1, rate: 120, amount: 120, is_taxable: true, created_at: now, updated_at: now },
      });

      await reprice(tx, txnId, 900_000);
      await serviceFor(tx).refreshFromDeal(tx as never, txnId, null);

      const extra = await tx.invoice_line_items.findFirstOrThrow({ where: { invoice_id: invoiceId, row_no: 2 } });
      expect(Number(extra.amount)).toBe(120);
      // And the invoice total carries both: the corrected commission plus the line that was added.
      expect(Number((await invoice(tx, invoiceId)).sub_total)).toBe(22_620);
    });
  }, 60000);
});
