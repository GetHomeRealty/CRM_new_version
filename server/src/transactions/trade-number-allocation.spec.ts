import { UnprocessableEntityException } from '@nestjs/common';
import { TradeNumberService } from './trade-number.service';

/**
 * TD-008 — the trade-number allocator asks the database for one row, not for the whole table.
 *
 * THE DEFECT. `next()` ran `findMany({ select: { trade_no: true } })` with no `where`: every
 * transaction number in the brokerage, including soft-deleted ones, loaded into memory and scanned
 * in JavaScript — on every create, inside the create's own write transaction. Harmless at nine
 * rows, a full table read per create at scale, holding a write transaction open while it happened.
 *
 * MEASURED on 400,000 seeded numbers in an isolated temp table with the same unique index:
 *
 *   old  `findMany` + JS scan           400,000 rows to the client      371 ms
 *   new  ORDER BY … DESC LIMIT 1        Index Only Scan Backward,
 *                                       Heap Fetches: 1                   0.14 ms
 *
 * An intermediate form, `MAX(LEFT(trade_no, 6)::int)`, is what this test file exists to warn
 * against: it used the index and STILL took 76 ms, because an aggregate over an expression cannot
 * stop early and walks all 100,000 rows of the band. Ordering by the bare indexed column is what
 * makes it constant-time. If somebody later rewrites this query as a `MAX(...)`, the behaviour
 * tests below still pass and the performance quietly goes — hence the assertion on the shape.
 *
 * NO DATABASE. `$queryRaw` is stubbed, and each test inspects the SQL that would have been sent.
 */

interface Asked { sql: string; params: unknown[] }

/** A service whose one query answers with `top`, recording what it was asked. */
const service = (top: string | undefined): { svc: TradeNumberService; asked: Asked; usedFindMany: () => boolean } => {
  const asked: Asked = { sql: '', params: [] };
  let findManyCalled = false;
  const db = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      asked.sql = strings.join('?').replace(/\s+/g, ' ').trim();
      asked.params = values;
      return Promise.resolve(top === undefined ? [] : [{ trade_no: top }]);
    },
    transactions: {
      findMany: () => { findManyCalled = true; return Promise.resolve([]); },
    },
  } as never;
  return { svc: new TradeNumberService(), asked, usedFindMany: () => findManyCalled, db } as never;
};

const next = async (type: string, top: string | undefined): Promise<{ value: string | UnprocessableEntityException; asked: Asked; usedFindMany: boolean }> => {
  const s = service(top) as unknown as { svc: TradeNumberService; asked: Asked; usedFindMany: () => boolean; db: never };
  try {
    const value = await s.svc.next(s.db, type);
    return { value, asked: s.asked, usedFindMany: s.usedFindMany() };
  } catch (e) {
    return { value: e as UnprocessableEntityException, asked: s.asked, usedFindMany: s.usedFindMany() };
  }
};

describe('trade numbers are allocated by an indexed lookup (TD-008)', () => {
  it('never reads the transactions table in full', async () => {
    const r = await next('Residential Buying', '200837');
    expect(r.usedFindMany).toBe(false);
  });

  it('asks for exactly one row, ordered by the indexed column', async () => {
    // The shape IS the fix. `LIMIT 1` over a backward index scan is what makes this constant-time;
    // an aggregate over an expression would use the index and still read the whole band.
    const { asked } = await next('Residential Buying', '200837');
    expect(asked.sql).toMatch(/ORDER BY trade_no DESC/i);
    expect(asked.sql).toMatch(/LIMIT 1/i);
    expect(asked.sql).not.toMatch(/MAX\s*\(/i);
  });

  it('bounds the query to the series band, so the index can range-scan it', async () => {
    const { asked } = await next('Residential Buying', '200837');
    expect(asked.params).toEqual(['200000', '300000']);
    expect(asked.sql).toMatch(/trade_no >= \? AND trade_no < \?/i);
  });

  it('filters to well-formed numbers, so a stray value cannot win the sort', async () => {
    // '2999999' sorts ABOVE '299999' lexicographically — it is the shorter string's own prefix
    // extended — so without the shape filter a seven-digit stray would be picked as the highest.
    const { asked } = await next('Residential Buying', '200837');
    expect(asked.sql).toContain("trade_no ~ '^[0-9]{6}(_NB)?$'");
  });

  it('does not filter out soft-deleted deals, whose numbers are still spent', async () => {
    const { asked } = await next('Residential Buying', '200837');
    expect(asked.sql).not.toMatch(/deleted_at/i);
  });

  const BANDS: [string, string, string, string][] = [
    ['Residential Sale Listing', '100000', '199998', '199999'],
    ['Residential Buying', '200000', '200837', '200838'],
    ['Preconstruction', '300000', '300010', '300011'],
    ['Residential Lease', '400000', '400000', '400001'],
    ['Referral', '500000', '500012_NB', '500013_NB'],
  ];

  it.each(BANDS)('allocates one above the highest issued for %s', async (type, _start, top, expected) => {
    const r = await next(type, top);
    expect(r.value).toBe(expected);
  });

  it.each(BANDS)('starts at the band floor for %s when nothing has been issued', async (type, start) => {
    const r = await next(type, undefined);
    const suffix = type === 'Referral' ? '_NB' : '';
    expect(r.value).toBe(start + suffix);
  });

  it('parses the six digits and ignores the suffix', async () => {
    const r = await next('Referral', '599998_NB');
    expect(r.value).toBe('599999_NB');
  });

  it('refuses rather than spilling into the next series when a band is full', async () => {
    // TD-127's rule, still enforced: a full series stops, it does not borrow the next one's range.
    const r = await next('Residential Buying', '299999');
    expect(r.value).toBeInstanceOf(UnprocessableEntityException);
    const body = (r.value as UnprocessableEntityException).getResponse() as { message: string };
    expect(body.message).toContain('is full');
  });

  it('treats an unknown transaction type as Buying, as it always did', async () => {
    const r = await next('Something Nobody Defined', '200837');
    expect(r.value).toBe('200838');
    expect(r.asked.params).toEqual(['200000', '300000']);
  });
});
