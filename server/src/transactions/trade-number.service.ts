import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * ONE COUNTER FOR EVERY DEAL, 000001 UPWARDS - the brokerage's decision of 2026-10-07.
 *
 * Until then each deal type owned a band (Listing 100000-199999, Buying 200000-299999,
 * Preconstruction 300000-399999, Lease 400000-499999, Referral 500000-599999_NB) and a number could
 * also be chosen by hand, or taken from the bulk-import sheet as it stood. Sai, 2026-10-05/07:
 * "i want a trade number like first trade number 000001, six digit generic number", the app gives
 * every number - on screen and in the bulk import alike - and nobody types one.
 *
 * WHAT STAYS EXACTLY AS IT WAS:
 *   - Deals that already exist keep their numbers. Renumbering them is a separate, later step.
 *   - A Referral keeps its `_NB` suffix on the same counter: 000045_NB, never a second 000045.
 *   - A spent number stays spent, deleted deal or not, and two creates at once never share one.
 *
 * WHY 000001-099999 AND NOT AN OPEN-ENDED COUNT. Every number in use today is 100000 or above, so
 * a counter that stays below 100000 cannot collide with any of them - and the deal invoice, which
 * is "GHR-" + the trade number, cannot collide with an existing invoice either. 99,999 deals is
 * centuries at this brokerage's volume; if it is ever reached the counter refuses loudly rather
 * than walking into the old numbers.
 */
const SERIES = { start: 1, end: 99999, width: 6 } as const;

/**
 * TD-076 - the advisory-lock class for trade-number allocation.
 *
 * Advisory locks share one global space, so the class namespaces this rule. With one counter
 * there is one lock; the second argument is kept so the key reads the same in `pg_locks`.
 */
const TRADE_NUMBER_LOCK_CLASS = 7601;
const TRADE_NUMBER_LOCK_KEY = 1;

/** Referral deals carry the brokerage's National Bank suffix on the shared counter. */
const suffixFor = (type: string): string => (String(type ?? '').trim() === 'Referral' ? '_NB' : '');

const pad = (n: number): string => String(n).padStart(SERIES.width, '0');

@Injectable()
export class TradeNumberService {
  /*
   * TD-008 - ONE ROW, NOT THE TABLE. The highest number already issued on the counter is found by
   * the database with `ORDER BY trade_no DESC LIMIT 1` over a range on the indexed column, which
   * walks the index backwards and stops at the first row (0.1 ms on 400,000 seeded numbers, where
   * MAX() over an expression read the whole range). The comparison is on text, and every value it
   * can see here is six zero-padded digits, where text order and number order coincide.
   *
   * THE SHAPE FILTER IS STILL NEEDED. The table holds numbers like '001' from before any series
   * existed; '001' sorts inside '000001'..'100000' as text, so without the regex it could be taken
   * for the highest. With it, the backward scan simply skips such a row.
   *
   * TD-127 - monotonic: one above the highest ever issued, gaps left alone, because a number that
   * has appeared on a client document should not be handed to a second deal.
   *
   * Soft-deleted rows are included on purpose: their numbers occupy the unique index, and a number
   * that has been issued is spent whether or not the deal survived.
   */
  async next(db: Tx, type: string): Promise<string> {
    const suffix = suffixFor(type);
    const lo = pad(SERIES.start);
    const hi = String(SERIES.end + 1);

    /*
     * TD-076 - TWO CREATES AT ONCE MUST NOT BE HANDED THE SAME NUMBER. Allocation is read-then-
     * insert, so the counter is serialised for the rest of the transaction and the read and the
     * insert that follows it are one step as far as any other create is concerned.
     *
     * `pg_advisory_xact_lock(int, int)` with the casts spelled out: Prisma sends a JS number as a
     * bigint parameter, and there is no two-argument bigint form of the function.
     */
    await db.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1::int, $2::int)', TRADE_NUMBER_LOCK_CLASS, TRADE_NUMBER_LOCK_KEY);
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
    const highest = top === undefined ? SERIES.start - 1 : parseInt(top.slice(0, SERIES.width), 10);
    const candidate = highest + 1;
    if (candidate <= SERIES.end) return pad(candidate) + suffix;

    /*
     * TD-140 - ONE DEAL AT THE TOP MUST NOT KILL THE COUNTER. When the ceiling is taken, fall back
     * to the LOWEST number nobody holds - in EITHER form, plain or _NB, because both share the
     * counter. Nothing is re-issued: the anti-join asks the table itself, so a number held by any
     * row, deleted or live, is skipped. Only on the fallback, so ordinary allocation stays the
     * single indexed read above.
     */
    const gap = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT g.n::int AS n
         FROM generate_series($1::int, $2::int) AS g(n)
        WHERE NOT EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.trade_no IN (lpad(g.n::text, 6, '0'), lpad(g.n::text, 6, '0') || '_NB')
            )
        ORDER BY g.n
        LIMIT 1`,
      SERIES.start, SERIES.end);
    if (gap.length && gap[0] && gap[0].n !== null && gap[0].n !== undefined) return pad(gap[0].n) + suffix;

    const msg = `Every trade number from ${pad(SERIES.start)} to ${pad(SERIES.end)} has been issued. `
      + 'No further deals can be numbered until the counter is extended.';
    throw new UnprocessableEntityException({ message: msg, errors: { trade_no: [msg] } });
  }

  /**
   * Why a typed-in trade number cannot be used, or null when none was typed.
   *
   * Since 2026-10-07 THE APP GIVES EVERY NUMBER. A number arriving from a screen, the API or the
   * bulk-import sheet is refused rather than quietly replaced, so whoever sent it finds out instead
   * of believing it was used. The bulk import clears the sheet's column before it gets here and
   * hands the file back afterwards with the number the app gave each row.
   */
  async manualProblem(_db: Tx, _type: string, raw: unknown): Promise<string | null> {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    return `"${value}" cannot be used: trade numbers are given by the app automatically. Leave the trade number blank.`;
  }
}
