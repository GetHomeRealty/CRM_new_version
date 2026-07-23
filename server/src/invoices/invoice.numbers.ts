import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Next invoice number (prefix + continuous counter) + transaction-tied numbers. */
@Injectable()
export class InvoiceNumberService {
  /** INV-601107 → INV-601108, advancing the counter. */
  async next(db: Tx): Promise<string> {
    const s = await db.company_settings.findUnique({ where: { id: 1 } });
    const no = Number(s?.next_invoice_no ?? 601107);
    const prefix = s?.invoice_prefix ?? 'INV-';
    await db.company_settings.update({ where: { id: 1 }, data: { next_invoice_no: no + 1, updated_at: new Date() } });
    return prefix + no;
  }

  /** §12.5 — GHR-<trade> or GHR-<trade>_Term <n>; null when no trade number. */
  forTransaction(tradeNo: string | null | undefined, termNo: number | null = null): string | null {
    if (!tradeNo) return null;
    return 'GHR-' + tradeNo + (termNo ? `_Term ${termNo}` : '');
  }
}
