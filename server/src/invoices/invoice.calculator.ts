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
      include: { invoice_line_items: true, invoice_payments: { where: { deleted_at: null } } },
    });
    if (!inv) return;

    const amounts=this.amounts(inv.invoice_line_items,Number(inv.discount??0),taxRate,inv.invoice_payments.map(p=>Number(p.amount)));
    const {sub_total:subTotal,tax_total:taxTotal,total,amount_paid:paid,balance_due:balance}=amounts;
    await db.invoices.update({
      where: { id: invoiceId },
      data: {
        sub_total: round2(subTotal),
        tax_total: taxTotal,
        total,
        amount_paid: paid,
        balance_due: balance,
        status: this.status(inv.status, total, paid, balance),
        updated_at: new Date(),
      },
    });
  }

  amounts(lines:{qty:unknown;rate:unknown;is_taxable:boolean}[],discount:number,taxRate:number,payments:number[]=[]){
    let subTotal=0,taxable=0;for(const line of lines){const amount=round2(Number(line.qty)*Number(line.rate));subTotal+=amount;if(line.is_taxable)taxable+=amount;}const taxTotal=round2(taxable*taxRate/100),total=round2(subTotal+taxTotal-round2(discount)),paid=round2(payments.reduce((sum,amount)=>sum+amount,0));return{sub_total:round2(subTotal),tax_total:taxTotal,total,amount_paid:paid,balance_due:round2(total-paid)};
  }

  private status(current: string, total: number, paid: number, balance: number): string {
    if (current === 'Void' || current === 'Paid' || current === 'Due' || current === 'Overdue') return current;
    if (current === 'Draft' && paid <= 0) return 'Draft';
    if (total > 0 && balance <= 0) return 'Paid';
    if (paid > 0) return 'Partially Paid';
    return 'Unpaid';
  }
}
