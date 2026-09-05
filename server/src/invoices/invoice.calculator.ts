import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { round2 } from '../common/serialize';

type Tx = Prisma.TransactionClient;

/** Recomputes invoice money fields + status (port of InvoiceCalculator). */
@Injectable()
export class InvoiceCalculator {
  static readonly TERM_DAYS: Record<string, number> = { 'Due on Receipt': 0, 'Net 7': 7, 'Net 15': 15, 'Net 30': 30 };

  async recalculate(db: Tx, invoiceId: number, taxRate: number): Promise<void> {
    const inv = await db.invoices.findUnique({
      where: { id: invoiceId },
      include: { invoice_line_items: true, invoice_payments: true },
    });
    if (!inv) return;

    let subTotal = 0;
    let taxable = 0;
    for (const it of inv.invoice_line_items) {
      const amount = round2(Number(it.qty) * Number(it.rate));
      subTotal += amount;
      if (it.is_taxable) taxable += amount;
    }
    const taxTotal = round2((taxable * taxRate) / 100);
    const discount = round2(Number(inv.discount ?? 0));
    const total = round2(subTotal + taxTotal - discount);
    const paid = round2(inv.invoice_payments.reduce((s, p) => s + Number(p.amount), 0));
    const balance = round2(total - paid);

    await db.invoices.update({
      where: { id: invoiceId },
      data: {
        sub_total: round2(subTotal),
        tax_total: taxTotal,
        /*
         * TD-093 — the rate that produced `tax_total`, stored alongside it.
         *
         * Every invoice carried the right tax and no way to prove which rate made it: the column
         * existed and was never written, so `tax_rate` came back null on a record whose arithmetic
         * reconciled to the cent. An applied-but-unrecorded rate cannot be evidenced later, and
         * becomes a real problem the day the rate changes.
         *
         * Written HERE rather than at each call site, because this is the one place that actually
         * applies it. Every caller — auto-generation, manual create, update, and the two payment
         * recalcs — already passes the rate it resolved, so the stored value is the applied value
         * by construction, not by a second assignment that could drift from it.
         */
        tax_rate: taxRate,
        total,
        amount_paid: paid,
        balance_due: balance,
        status: this.status(inv.status, total, paid, balance),
        updated_at: new Date(),
      },
    });
  }

  private status(current: string, total: number, paid: number, balance: number): string {
    // TD-021 / TD-131 - 'Paid' is DERIVED from the money, not a label that outranks it.
    //
    // Paid used to sit in this terminal list, which had two consequences. An invoice marked Paid by
    // hand kept that label with its full balance still owing, and an invoice that reached Paid
    // honestly could never come back down when its payments were removed - the status froze while
    // the money underneath moved. Void stays terminal because it is a deliberate decision about the
    // document rather than a statement about the balance; Due and Overdue stay because they are
    // chase states a person sets and no payment contradicts.
    if (current === 'Void') return current;
    if (current === 'Draft' && paid <= 0) return 'Draft';
    if (total > 0 && balance <= 0) return 'Paid';
    if (paid > 0) return 'Partially Paid';
    if (current === 'Due' || current === 'Overdue') return current;
    if (current === 'Draft' && paid <= 0) return 'Draft';
    if (total > 0 && balance <= 0) return 'Paid';
    if (paid > 0) return 'Partially Paid';
    return 'Unpaid';
  }
}
