import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** One numbering series. Each owns a band and never leaves it. */
type Series = { label: string; start: number; end: number; suffix: string };

const SERIES: Record<string, Series> = {
  listing:  { label: 'Listing / Sale',            start: 100000, end: 199999, suffix: '' },
  buying:   { label: 'Buying',                    start: 200000, end: 299999, suffix: '' },
  precon:   { label: 'Preconstruction',           start: 300000, end: 399999, suffix: '' },
  lease:    { label: 'Lease',                     start: 400000, end: 499999, suffix: '' },
  referral: { label: 'Referral (National Bank)',  start: 500000, end: 599999, suffix: '_NB' },
};

/** Series by transaction type, keyed on what the deal IS rather than its property class. */
const BY_TYPE: Record<string, keyof typeof SERIES> = {
  'Residential Sale Listing': 'listing',
  'Residential Lease Listing': 'listing',
  'Commercial Property Sale Listing': 'listing',
  'Commercial Property Lease Listing': 'listing',
  'Business Sale': 'listing',
  'Residential Buying': 'buying',
  'Commercial Property Buying': 'buying',
  'Business Buying': 'buying',
  'Preconstruction': 'precon',
  'Residential Lease': 'lease',
  'Commercial Property Lease': 'lease',
  'Referral': 'referral',
};

@Injectable()
export class TradeNumberService {
  /*
   * TD-127. The old allocator gave each series a `matches` predicate and walked up from its
   * start to the first gap. Residential Buying was 1-99, so once those were used `candidate`
   * reached 100 - which was NOT in `used`, because the predicate had filtered it out as a Lease
   * number. The loop stopped there and returned 100. And 100 every time after that, since a
   * number outside the predicate can never enter the set the loop tests against. The 100th
   * buying deal collided with an existing lease and was refused by the unique index, which is
   * the only thing that stopped a genuine duplicate.
   *
   * Two things changed. A series now REFUSES when it is full instead of falling through into
   * the next one's range. And allocation is MONOTONIC - one above the highest ever issued in
   * that band, gaps left alone - because a trade number that has appeared on a client document
   * should not be handed to a second deal.
   */
  /*
   * TD-008. This read the WHOLE transactions table on every create — `findMany({ select: {
   * trade_no: true } })` with no `where` — pulled every number into memory and scanned them in
   * JavaScript, inside the create's transaction. Harmless at nine rows; a full table read per
   * create at brokerage scale, holding a write transaction open while it happens.
   *
   * It is now one row: the highest number already issued in this series, found by the database.
   *
   * WHY A RANGE PREDICATE RATHER THAN A REGEX ALONE. `trade_no` is `@unique`, so it carries a
   * btree index, and `>= '200000' AND < '300000'` is a range scan on that index. A regex cannot
   * use the index and would scan regardless. The comparison is on text, but every value it can
   * distinguish here is six digits of equal length, where lexicographic and numeric order
   * coincide; the band's own boundary is settled by the FIRST character ('2' vs '3'), which no
   * collation reorders.
   *
   * WHY `ORDER BY ... DESC LIMIT 1` AND NOT `MAX(...)`. Measured on 400,000 seeded numbers, the
   * obvious `MAX(LEFT(trade_no, 6)::int)` used the index and still took 76 ms, reading all 100,000
   * rows of the band: an aggregate over an EXPRESSION cannot use the index's ordering to stop
   * early, so Postgres walks the whole range and computes the maximum row by row. Ordering by the
   * bare indexed column instead walks the index backwards and stops at the first row — 0.1 ms, one
   * heap fetch, and flat as the table grows. The six digits are parsed here rather than in SQL for
   * the same reason: casting inside the query is what made it an expression.
   *
   * THE REGEX IS STILL NEEDED, as a filter on top: this table holds numbers like '001' from
   * before the series existed, and nothing in the schema prevents a non-conforming value. '001'
   * falls outside every band's range anyway, but a hypothetical '2abc' would sort inside one, and
   * taking a lexicographic maximum without the shape check could hand back a number derived from
   * it. With the filter, the backward scan simply skips such a row and takes the next.
   *
   * NOT A DATABASE SEQUENCE, though the defect offers one. A trade number may also be chosen BY
   * HAND — `manualProblem` exists for exactly that, filing a historical deal under the number it
   * already carried — and a sequence would not know about those, so it would eventually hand out
   * a number a manual entry had already taken. Deriving from what is actually stored keeps manual
   * and automatic allocation on the same line.
   *
   * Soft-deleted rows are still included, on purpose and as before: their numbers occupy the
   * unique index, and a number that has been issued is spent whether or not the deal survived.
   */
  async next(db: Tx, type: string): Promise<string> {
    const s = SERIES[BY_TYPE[type] ?? 'buying'];
    const lo = String(s.start);
    const hi = String(s.end + 1);
    const rows = await db.$queryRaw<{ trade_no: string }[]>`
      SELECT trade_no
        FROM transactions
       WHERE trade_no >= ${lo}
         AND trade_no <  ${hi}
         AND trade_no ~ '^[0-9]{6}(_NB)?$'
       ORDER BY trade_no DESC
       LIMIT 1
    `;
    const top = rows[0]?.trade_no;
    const highest = top === undefined ? s.start - 1 : parseInt(top.slice(0, 6), 10);
    const candidate = highest + 1;
    if (candidate > s.end) {
      const msg = `The ${s.label} trade number series (${s.start}-${s.end}) is full. `
        + 'No further deals of this type can be numbered until the range is extended.';
      throw new UnprocessableEntityException({ message: msg, errors: { trade_no: [msg] } });
    }
    return String(candidate) + s.suffix;
  }

  /** The band a type belongs to, for callers validating a manually-chosen number. */
  seriesFor(type: string): Series {
    return SERIES[BY_TYPE[type] ?? 'buying'];
  }

  /*
   * Why this hand-picked trade number cannot be used, or null if it can.
   *
   * A number may be chosen by hand - filing a historical deal under the number it already
   * carried - but it must still belong to its type's band, or the bands stop meaning anything
   * and the next automatic allocation walks into it. Three ways it can be wrong, each answered
   * separately, because "invalid" tells somebody nothing about which of the three they hit.
   *
   * Returns a SENTENCE, not a boolean: the caller shows it to a person who has just typed a
   * number, or puts it in the import review table beside the row that carried it.
   */
  async manualProblem(db: Tx, type: string, raw: unknown): Promise<string | null> {
    const s = this.seriesFor(type);
    const value = String(raw ?? '').trim();
    if (!value) return null;
    const m = /^(\d{6})(_NB)?$/.exec(value);
    const shape = s.suffix ? `six digits followed by ${s.suffix}` : 'six digits';
    if (!m) return `"${value}" is not a trade number. Use ${shape} - for example ${s.start}${s.suffix}.`;
    if ((m[2] ?? '') !== s.suffix) {
      return `"${value}" has the wrong form for a ${s.label} deal. Use ${shape} - for example ${s.start}${s.suffix}.`;
    }
    const n = parseInt(m[1], 10);
    if (n < s.start || n > s.end) {
      return `${value} is outside the ${s.label} series (${s.start}-${s.end}). Each transaction type keeps its own range, so a ${s.label} deal cannot take a number from another one.`;
    }
    const taken = await db.transactions.findFirst({ where: { trade_no: value }, select: { property: true } });
    if (taken) {
      const where = taken.property ? ` (${taken.property})` : '';
      return `Trade number ${value} is already assigned${where}. Choose another, or leave it blank to have one allocated.`;
    }
    return null;
  }
}
