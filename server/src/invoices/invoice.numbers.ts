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
  /**
   * INDIA (19 Oct 2026, Sai: "ghr is enough"): GHR/2026-27/0001, GHR/2026-27/0002, ... - one series per
   * Indian financial year (1 April - 31 March), restarting at 0001 each April. One above the highest
   * number issued in that year, under its own advisory lock so two invoices never take the same number.
   */
  static indiaFinancialYear(d: Date): string {
    const y = d.getUTCFullYear();
    const start = d.getUTCMonth() >= 3 ? y : y - 1; // April (month 3) starts the year
    return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
  }

  async nextIndia(db: Tx, invoiceDate: Date, prefix = 'GHR'): Promise<string> {
    const head = `${prefix}/${InvoiceNumberService.indiaFinancialYear(invoiceDate)}/`;
    await db.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1::int, $2::int)', 7601, 3);
    const rows = await db.$queryRaw<{ invoice_no: string }[]>`
      SELECT invoice_no FROM invoices
       WHERE invoice_no LIKE ${head + '%'} AND invoice_no ~ '/[0-9]{4,}$'
       ORDER BY length(invoice_no) DESC, invoice_no DESC LIMIT 1`;
    const top = rows[0]?.invoice_no;
    const n = top ? parseInt(top.slice(head.length), 10) + 1 : 1;
    return head + String(n).padStart(4, '0');
  }

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
