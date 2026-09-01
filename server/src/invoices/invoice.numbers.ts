import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * TD-117 — the prefix used when the settings row cannot be read at all.
 *
 * 'GHR-' rather than the schema's 'INV-', because it is what every transaction invoice in the
 * system already carries and a fallback should land on the numbering in use, not on a scheme
 * nothing has ever been raised under. The schema default is deliberately left alone: changing it
 * means `ALTER TABLE ... SET DEFAULT`, and the application's database user cannot alter tables.
 */
const DEFAULT_PREFIX = 'GHR-';

/** Next invoice number (prefix + continuous counter) + transaction-tied numbers. */
@Injectable()
export class InvoiceNumberService {
  /** GHR-601107 → GHR-601108, advancing the counter. */
  async next(db: Tx): Promise<string> {
    const s = await db.company_settings.findUnique({ where: { id: 1 } });
    const no = Number(s?.next_invoice_no ?? 601107);
    const prefix = s?.invoice_prefix ?? DEFAULT_PREFIX;
    await db.company_settings.update({ where: { id: 1 }, data: { next_invoice_no: no + 1, updated_at: new Date() } });
    return prefix + no;
  }

  /**
   * §12.5 — <prefix><trade> or <prefix><trade>_Term <n>; null when no trade number.
   *
   * TD-117 — the prefix is passed in rather than hardcoded 'GHR-'. Company Settings carries an
   * Invoice Prefix field, and it described nothing: this method produced every transaction invoice
   * in the system and never read it, so an administrator opening the setting to learn how invoices
   * are numbered was told 'INV-' while every invoice on file read GHR-. Two numbering schemes
   * existed side by side — `next()` above honoured the setting, this did not — and the one nobody
   * had configured was the one almost every invoice used.
   *
   * A PARAMETER RATHER THAN A LOOKUP, so this stays synchronous and reads the settings row its
   * caller has already fetched. The caller is generating invoices in a loop over preconstruction
   * terms; a lookup here would be one query per term for a value that cannot change between them.
   */
  forTransaction(tradeNo: string | null | undefined, termNo: number | null = null, prefix = DEFAULT_PREFIX): string | null {
    if (!tradeNo) return null;
    return prefix + tradeNo + (termNo ? `_Term ${termNo}` : '');
  }
}
