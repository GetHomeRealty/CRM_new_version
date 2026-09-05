import { PrismaClient } from '@prisma/client';
import { UnprocessableEntityException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionsWriteService } from './transactions-write.service';
import { PersonResolver } from '../core/person-resolver.service';
import { TradeNumberService } from './trade-number.service';

/**
 * TD-076 — two saves of the same deal, fired together, produce one deal and one refusal.
 *
 * WHAT WAS REPORTED, AND WHAT IT BECAME. The entry is a 500 on a double-click; that no longer
 * reproduces. The re-test found the real defect underneath it: fired simultaneously, both creates
 * returned 201 and TWO IDENTICAL DEALS were written. The guard is a SELECT followed by an INSERT,
 * so both requests looked, both found nothing, and both inserted. Sequentially it has always
 * worked, which is exactly why this went unnoticed — and why the client's own double-submit guard
 * hides it from ordinary users while a retry, a flaky connection or two people saving the same
 * deal still reach it.
 *
 * WHY NOT A UNIQUE INDEX. The rule is fuzzy on the address — `propertiesSimilar` matches "9 Oak
 * Rd" to "9 Oak Road Unit 2" — so there is no column tuple to constrain. What can be serialised is
 * the candidate set: every deal sharing Type, Price and Offer Date. The check and the insert now
 * run in one transaction under an advisory lock on that key, so the loser of a race sees the
 * winner's row and gets the same 422 the sequential path produces.
 *
 * THIS TEST NEEDS REAL CONCURRENCY, so it does not use the rolled-back-transaction harness the
 * other specs use: two connections inside one outer transaction cannot see each other, which is
 * the very thing under test. It writes to the database and cleans up after itself in `finally`.
 */

const prisma = new PrismaClient();
let seq = 0;

afterAll(async () => { await prisma.$disconnect(); });

const service = (): TransactionsWriteService => {
  const p = prisma as unknown as PrismaService;
  const deps = [
    p,
    {},
    { record: async () => undefined, recordChanges: async () => [], snapshot: async () => ({}) },
    ...Array.from({ length: 7 }, () => ({})),
  ] as unknown as ConstructorParameters<typeof TransactionsWriteService>;
  const svc = new TransactionsWriteService(...deps);
  // The collaborators the create path actually calls. `people` and `tradeNumbers` do real work —
  // the trade number is part of the refusal message. The rest are the best-effort steps that run
  // AFTER the row is written (invoice generation, the lawyer nudge) and the resource read-back;
  // stubbed, because this test is about what the database ends up holding.
  const real = svc as unknown as Record<string, unknown>;
  real.people = new PersonResolver(p);
  real.tradeNumbers = new TradeNumberService();
  real.txnInvoices = { generate: async () => undefined };
  real.lawyerReminder = { maybeRemind: () => undefined };
  real.loadResource = async (id: number) => ({ data: { id } });
  return svc;
};

const admin = { id: 1, name: 'QA Concurrency', role: 'admin' } as never;

const body = (property: string) => ({
  type: 'Residential Buying',
  property,
  status: 'Secured Firm',
  price: 512_345,
  comm_type: '%',
  comm_value: 2.5,
  offer_date: '2026-08-13',
  /*
   * A closing date far outside every other spec's window, on purpose.
   *
   * This spec writes REAL rows to the shared development database — it cannot use the rolled-back
   * harness, because two connections inside one outer transaction cannot see each other, which is
   * the thing under test. So for the moments they exist, these rows are visible to every suite
   * running in parallel, and any of them that counts deals in a date range can pick them up.
   *
   * Measured twice. A near date put them inside the reminder sweeps' window and
   * reminder-retry.spec.ts failed once, then passed. Moving them to 2030 put them inside the
   * Analytics filter test's "empty result" range (2030-01-01 to 2030-12-31), which failed the same
   * intermittent way. 2099 is outside both, and outside anything a fixture is likely to reach for.
   */
  closing_date: '2099-12-31',
});

/** 201 for a created deal, 422 for the duplicate refusal, or whatever else came back. */
const outcome = async (call: Promise<unknown>): Promise<{ code: 201 | 422 | 500; message: string }> => {
  try {
    await call;
    return { code: 201, message: '' };
  } catch (e) {
    if (e instanceof UnprocessableEntityException) {
      return { code: 422, message: String((e.getResponse() as { message?: string }).message ?? '') };
    }
    return { code: 500, message: `${(e as Error).constructor.name}: ${(e as Error).message}` };
  }
};

describe('the duplicate guard holds under a simultaneous double submit (TD-076)', () => {
  jest.setTimeout(120_000);

  it('writes one deal and refuses the other, with the sequential message', async () => {
    const property = `ZZ-TEST TD076 Concurrent ${Date.now()}-${++seq} Road`;
    const svc = service();
    let ids: number[] = [];

    try {
      // Genuinely at once: both promises are in flight before either is awaited.
      const [a, b] = await Promise.all([
        outcome(svc.store(admin, body(property))),
        outcome(svc.store(admin, body(property))),
      ]);
      const codes = [a.code, b.code].sort();

      const rows = await prisma.transactions.findMany({ where: { property, deleted_at: null }, select: { id: true } });
      ids = rows.map((r) => r.id);

      expect(codes).toEqual([201, 422]);
      expect(ids).toHaveLength(1);
      // The loser is told the same thing it would have been told a second later.
      const refusal = a.code === 422 ? a.message : b.message;
      expect(refusal).toContain('Transaction already exists');
      expect(refusal).toContain('Same Type, Price and Offer Date with a matching Property Address.');
      // And neither request answered with the 500 the entry was originally raised for.
      expect([a.code, b.code]).not.toContain(500);
    } finally {
      if (ids.length) await prisma.transactions.deleteMany({ where: { id: { in: ids } } });
      await prisma.transactions.deleteMany({ where: { property } });
    }
  });

  it('gives four simultaneous creates in one band four different trade numbers', async () => {
    /*
     * THE OTHER RACE THIS TEST FOUND, and the one the entry was originally raised for.
     *
     * Allocation reads the highest number in the band and adds one, so two creates racing each
     * other computed the SAME candidate and the second died on the `trade_no` unique index — a 500
     * on a save that was in no way the user's fault. It fires between UNRELATED deals: only the
     * band has to match, which is why it survived a re-test that fired two copies of one deal.
     */
    const stamp = `${Date.now()}-${++seq}`;
    const svc = service();
    const properties = [0, 1, 2, 3].map((n) => `ZZ-TEST TD076 Band ${stamp}-${n} Road`);

    try {
      const results = await Promise.all(
        properties.map((property, n) => outcome(svc.store(admin, { ...body(property), price: 300_000 + n }))),
      );
      expect(results.map((r) => r.code)).toEqual([201, 201, 201, 201]);

      const rows = await prisma.transactions.findMany({
        where: { property: { in: properties } }, select: { trade_no: true },
      });
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => r.trade_no)).size).toBe(4);
    } finally {
      await prisma.transactions.deleteMany({ where: { property: { in: properties } } });
    }
  });

  it('does not serialise deals that are not candidates for each other', async () => {
    // The lock is keyed on Type + Price + Offer Date, so two unrelated saves must both succeed —
    // a guard that queued every create behind one lock would be its own defect.
    const stamp = `${Date.now()}-${++seq}`;
    const svc = service();
    const one = `ZZ-TEST TD076 Alpha ${stamp} Road`;
    const two = `ZZ-TEST TD076 Beta ${stamp} Road`;

    try {
      const [a, b] = await Promise.all([
        outcome(svc.store(admin, { ...body(one), price: 400_000 })),
        outcome(svc.store(admin, { ...body(two), price: 900_000 })),
      ]);
      expect([a.code, b.code]).toEqual([201, 201]);
      expect(await prisma.transactions.count({ where: { property: { in: [one, two] }, deleted_at: null } })).toBe(2);
    } finally {
      await prisma.transactions.deleteMany({ where: { property: { in: [one, two] } } });
    }
  });
});
