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
/** TD-076 — what the allocator locked before it looked, and in which order. */
interface Locked { sql: string; params: unknown[]; beforeTheQuery: boolean }

/** A service whose one query answers with `top`, recording what it was asked. */
const service = (top: string | undefined): { svc: TradeNumberService; asked: Asked; usedFindMany: () => boolean } => {
  const asked: Asked = { sql: '', params: [] };
  const locked: Locked = { sql: '', params: [], beforeTheQuery: false };
  let findManyCalled = false;
  const db = {
    // TD-076 — the band lock the allocation takes first, so a concurrent create cannot read the
    // same highest number and compute the same candidate.
    $executeRawUnsafe: (sql: string, ...values: unknown[]) => {
      locked.sql = sql;
      locked.params = values;
      locked.beforeTheQuery = asked.sql === '';
      return Promise.resolve(1);
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      asked.sql = strings.join('?').replace(/\s+/g, ' ').trim();
      asked.params = values;
      return Promise.resolve(top === undefined ? [] : [{ trade_no: top }]);
    },
    // TD-165 - THE FULL-BAND PATH ASKS FOR A REUSABLE GAP BEFORE IT REFUSES, and this stub was
    // never added when it did. next() calls $queryRawUnsafe to look for a freed number in the
    // range; with no stub the call landed on undefined and the band-full test saw a TypeError
    // instead of the UnprocessableEntityException it exists to check. TD-127's refusal was intact
    // throughout - the product had simply got better than the test.
    //
    // No rows means NO GAP, which is the case this file exercises: a genuinely full series.
    $queryRawUnsafe: () => Promise.resolve([]),
    transactions: {
      findMany: () => { findManyCalled = true; return Promise.resolve([]); },
    },
  } as never;
  return { svc: new TradeNumberService(), asked, locked, usedFindMany: () => findManyCalled, db } as never;
};

const next = async (type: string, top: string | undefined): Promise<{ value: string | UnprocessableEntityException; asked: Asked; locked: Locked; usedFindMany: boolean }> => {
  const s = service(top) as unknown as { svc: TradeNumberService; asked: Asked; locked: Locked; usedFindMany: () => boolean; db: never };
  try {
    const value = await s.svc.next(s.db, type);
    return { value, asked: s.asked, locked: s.locked, usedFindMany: s.usedFindMany() };
  } catch (e) {
    return { value: e as UnprocessableEntityException, asked: s.asked, locked: s.locked, usedFindMany: s.usedFindMany() };
  }
};

describe('allocation is serialised on the one counter (TD-076)', () => {
  it('takes the counter lock BEFORE reading the highest number', async () => {
    /*
     * The read and the insert that follows it are one step only if nothing else can read between
     * them. Two creates racing each other used to compute the same candidate, and the second died
     * on the `trade_no` unique index — a 500 on a save the user could do nothing about.
     */
    const r = await next('Residential Buying', '000837');
    expect(r.locked.sql).toContain('pg_advisory_xact_lock');
    expect(r.locked.beforeTheQuery).toBe(true);
  });

  it('every deal type takes the SAME lock, because they share one counter', async () => {
    // Since 2026-10-07 there are no bands: a Listing and a Buying create draw from the same counter,
    // so they must wait for each other or they could be handed the same number.
    const buying = await next('Residential Buying', '000837');
    const listing = await next('Residential Sale Listing', '000837');
    const referral = await next('Referral', '000837');
    expect(buying.locked.params).toEqual(listing.locked.params);
    expect(buying.locked.params).toEqual(referral.locked.params);
  });

  it('casts the arguments, because Prisma sends a JS number as a bigint', () => {
    // Without the casts Postgres answers 42883: there is no pg_advisory_xact_lock(bigint, bigint).
    expect.assertions(1);
    return next('Residential Buying', '000837').then((r) => expect(r.locked.sql).toContain('::int'));
  });
});

describe('trade numbers are allocated by an indexed lookup (TD-008)', () => {
  it('never reads the transactions table in full', async () => {
    const r = await next('Residential Buying', '000837');
    expect(r.usedFindMany).toBe(false);
  });

  it('asks for exactly one row, ordered by the indexed column', async () => {
    // The shape IS the fix. `LIMIT 1` over a backward index scan is what makes this constant-time;
    // an aggregate over an expression would use the index and still read the whole range.
    const { asked } = await next('Residential Buying', '000837');
    expect(asked.sql).toMatch(/ORDER BY trade_no DESC/i);
    expect(asked.sql).toMatch(/LIMIT 1/i);
    expect(asked.sql).not.toMatch(/MAX\s*\(/i);
  });

  it('bounds the query to 000001-099999, so it can never see a number from the old bands', async () => {
    const { asked } = await next('Residential Buying', '000837');
    expect(asked.params).toEqual(['000001', '100000']);
    expect(asked.sql).toMatch(/trade_no >= \? AND trade_no < \?/i);
  });

  it('filters to well-formed numbers, so a stray value cannot win the sort', async () => {
    // '001' from before any series existed sorts inside '000001'..'100000' as text; the shape filter
    // is what stops it being taken for the highest number.
    const { asked } = await next('Residential Buying', '000837');
    expect(asked.sql).toContain("trade_no ~ '^[0-9]{6}(_NB)?$'");
  });

  it('does not filter out soft-deleted deals, whose numbers are still spent', async () => {
    const { asked } = await next('Residential Buying', '000837');
    expect(asked.sql).not.toMatch(/deleted_at/i);
  });

  const TYPES = ['Residential Sale Listing', 'Residential Buying', 'Preconstruction', 'Residential Lease',
    'Residential Lease Listing', 'Commercial Property Buying', 'Business Sale', 'Referral'];

  it.each(TYPES)('starts at 000001 for %s when nothing has been issued', async (type) => {
    const r = await next(type, undefined);
    expect(r.value).toBe('000001' + (type === 'Referral' ? '_NB' : ''));
  });

  it.each(TYPES)('allocates one above the highest issued on the shared counter for %s', async (type) => {
    const r = await next(type, '000041');
    expect(r.value).toBe('000042' + (type === 'Referral' ? '_NB' : ''));
  });

  it('a Referral after a Buying deal takes the NEXT number, never the same one with _NB', async () => {
    const r = await next('Referral', '000044');
    expect(r.value).toBe('000045_NB');
  });

  it('a Buying deal after a Referral parses the six digits and ignores the suffix', async () => {
    const r = await next('Residential Buying', '000045_NB');
    expect(r.value).toBe('000046');
  });

  it('refuses rather than walking into the old numbers when the counter is full', async () => {
    const r = await next('Residential Buying', '099999');
    expect(r.value).toBeInstanceOf(UnprocessableEntityException);
    const body = (r.value as UnprocessableEntityException).getResponse() as { message: string };
    expect(body.message).toContain('has been issued');
  });

  it('treats an unknown transaction type like any other: next number, no suffix', async () => {
    const r = await next('Something Nobody Defined', '000837');
    expect(r.value).toBe('000838');
    expect(r.asked.params).toEqual(['000001', '100000']);
  });
});

describe('nobody chooses a trade number any more (2026-10-07)', () => {
  const svc = new TradeNumberService();
  it('a blank number is fine - the app gives one', async () => {
    expect(await svc.manualProblem({} as never, 'Residential Buying', '')).toBeNull();
    expect(await svc.manualProblem({} as never, 'Residential Buying', '   ')).toBeNull();
    expect(await svc.manualProblem({} as never, 'Residential Buying', null)).toBeNull();
  });
  it.each(['000123', '200954', '500001_NB', 'abc'])('a typed number (%s) is refused, and says why', async (raw) => {
    const problem = await svc.manualProblem({} as never, 'Residential Buying', raw);
    expect(problem).toContain('given by the app');
  });
});
