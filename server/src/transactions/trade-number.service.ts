import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Next trade number per transaction type (port of TradeNumberService). */
@Injectable()
export class TradeNumberService {
  async next(db: Tx, type: string): Promise<string> {
    const { start, useLegacy, matches } = this.rulesFor(type);
    // withTrashed — soft-deleted trade numbers still occupy the unique index.
    const rows = await db.transactions.findMany({ select: { trade_no: true } });
    const used = new Set(
      rows.map((r) => String(r.trade_no)).filter(matches).map((id) => parseInt(id, 10)),
    );
    let candidate = start;
    while (used.has(candidate)) candidate++;
    return useLegacy ? String(candidate) : String(candidate).padStart(3, '0');
  }

  private rulesFor(type: string): { start: number; useLegacy: boolean; matches: (id: string) => boolean } {
    if (type === 'Residential Buying') {
      return { start: 1, useLegacy: false, matches: (id) => /^\d{1,3}$/.test(id) && +id >= 1 && +id < 100 };
    }
    if (type === 'Residential Lease') {
      return { start: 100, useLegacy: false, matches: (id) => /^\d{1,3}$/.test(id) && +id >= 100 && +id <= 999 };
    }
    return { start: 200836, useLegacy: true, matches: (id) => +id >= 200000 };
  }
}
