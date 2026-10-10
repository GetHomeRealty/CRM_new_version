import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { filterClauses } from './transaction-filters';

/**
 * 2026-10-10 - THE TRANSACTIONS LIST OPENS ON "THIS YEAR ONWARD", BY CLOSING DATE.
 *
 * Sai: "i want that to be the current year by default, if any one wants to check for any other years
 * they can set the required filters and can check." A plain year would drop every deal with no closing
 * date yet - most live listings - and every live deal closing next year (live on 10 Oct: 72 and 37 of
 * the 170 deals being worked). So the default, "YYYY+", is that year onward PLUS no closing date, and a
 * single year chosen from the list still means exactly that year, as it always did.
 *
 * Real rows in a rolled-back transaction: this is a query, and what matters is what the database does
 * with it - in particular that NULL closing dates are kept by "YYYY+" and dropped by "YYYY".
 */
const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

async function fixture(tx: PrismaService) {
  const now = new Date();
  const stamp = `${Date.now()}`;
  const mk = async (tag: string, closing: string | null) => (await tx.transactions.create({
    data: {
      trade_no: `YRDEF-${stamp}-${tag}`, type: 'Residential Buying', property: `ZZ-TEST ${stamp} ${tag}`,
      closing_date: closing ? new Date(`${closing}T00:00:00.000Z`) : null,
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
    },
  })).id;
  return {
    stamp,
    y2025: await mk('2025', '2025-12-31'),
    y2026a: await mk('2026a', '2026-01-01'),
    y2026b: await mk('2026b', '2026-12-31'),
    y2027: await mk('2027', '2027-06-15'),
    none: await mk('none', null),
  };
}

const ids = async (tx: PrismaService, stamp: string, year: string) =>
  (await tx.transactions.findMany({
    where: { AND: [{ property: { startsWith: `ZZ-TEST ${stamp}` } }, ...filterClauses({ year } as never)] },
    select: { id: true }, orderBy: { id: 'asc' },
  })).map((r) => r.id);

describe('the Transactions list opens on this year onward, by closing date', () => {
  it('"2026+" keeps 2026, later years and deals with no closing date; leaves 2025 out', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      expect(await ids(tx, f.stamp, '2026+')).toEqual([f.y2026a, f.y2026b, f.y2027, f.none]);
    });
  });

  it('a single year still means exactly that year, as before', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      expect(await ids(tx, f.stamp, '2026')).toEqual([f.y2026a, f.y2026b]);
      expect(await ids(tx, f.stamp, '2025')).toEqual([f.y2025]);
    });
  });

  it('"All years" (blank) still shows everything', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      expect(await ids(tx, f.stamp, '')).toEqual([f.y2025, f.y2026a, f.y2026b, f.y2027, f.none]);
    });
  });

  it('anything else in the year box is ignored rather than guessed at', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      expect(await ids(tx, f.stamp, '26+')).toHaveLength(5);
      expect(await ids(tx, f.stamp, '2026++')).toHaveLength(5);
    });
  });
});
