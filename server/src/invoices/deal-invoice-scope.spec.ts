import { PrismaClient } from '@prisma/client';
import { txnShowInclude } from '../transactions/transaction.resource';

/**
 * TD-048 — the deal and the Invoice module describe the SAME invoice.
 *
 * The entry is about one invoice wearing different words on different screens. This is the last
 * instance of it, and it is not a wording fault at all: the deal was reading a different SET of
 * invoices from the one the Invoice module reads.
 *
 * `InvoicesService` filters `deleted_at: null` on every read it makes. The transaction's eager
 * include did not, so an invoice deleted into the Recycle Bin vanished from the Invoice list and
 * went on being reported by the deal's Admin Activities panel — number, status and all — which is
 * the same disagreement the entry was filed for, arrived at from the other end.
 *
 * AND IT MASKED A LIVE INVOICE. `invoiceAdmin` takes `invoices[0]`, the lowest id, so a deal whose
 * first invoice was deleted and replaced showed the DEAD one's status while a perfectly good
 * current invoice sat behind it.
 *
 * Asserted against the database rather than against the include literal: the filter is a Prisma
 * clause, and a test that reads the object back would pass on a clause that does not work. Rolled
 * back, so it writes nothing.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';

async function inRollback(fn: (tx: PrismaClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaClient);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

afterAll(async () => { await prisma.$disconnect(); });

describe('a deleted invoice is not the deal’s invoice (TD-048)', () => {
  const build = async (tx: PrismaClient) => {
    const now = new Date();
    const stamp = Date.now();
    const t = await tx.transactions.create({
      data: {
        trade_no: `ZZINV-${stamp}`, type: 'Residential Buying', agent: 'ZZ Test',
        price: 500_000, comm_type: '%', comm_value: 0, comm_pct: 2.5,
        comm_status: 'Pending', comm_paid_status: 'No',
        adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
        created_at: now, updated_at: now,
      },
    });
    const inv = async (no: string, status: string, deleted: boolean) => tx.invoices.create({
      data: {
        transaction_id: t.id, invoice_no: no, status,
        invoice_date: new Date('2026-01-01T00:00:00.000Z'),
        deleted_at: deleted ? now : null, created_at: now, updated_at: now,
      },
    });
    // Deleted FIRST, so it holds the lowest id — the masking case.
    const dead = await inv(`ZZ-DEAD-${stamp}`, 'Unpaid', true);
    const live = await inv(`ZZ-LIVE-${stamp}`, 'Paid', false);
    return { t, dead, live };
  };

  it('leaves a deleted invoice out of the deal, the way the Invoice module leaves it out', async () => {
    await inRollback(async (tx) => {
      const { t, dead, live } = await build(tx);

      const loaded = await tx.transactions.findUnique({ where: { id: t.id }, include: txnShowInclude });
      const nos = (loaded?.invoices ?? []).map((i) => i.invoice_no);

      expect(nos).toEqual([live.invoice_no]);
      expect(nos).not.toContain(dead.invoice_no);
    });
  }, 60000);

  it('does not let the deleted one mask the live one, which is what the panel reads', async () => {
    await inRollback(async (tx) => {
      const { t, live } = await build(tx);

      const loaded = await tx.transactions.findUnique({ where: { id: t.id }, include: txnShowInclude });
      // `invoiceAdmin` reads invoices[0]; before the fix that was the deleted invoice, so the deal
      // reported 'Unpaid' for a deal whose actual invoice was Paid.
      const first = (loaded?.invoices ?? [])[0];

      expect(first?.invoice_no).toBe(live.invoice_no);
      expect(first?.status).toBe('Paid');
    });
  }, 60000);

  it('still shows a deal’s only invoice when it has not been deleted', async () => {
    // The guard against over-filtering: this must not simply hide invoices.
    await inRollback(async (tx) => {
      const now = new Date();
      const stamp = Date.now();
      const t = await tx.transactions.create({
        data: {
          trade_no: `ZZINV2-${stamp}`, type: 'Residential Buying', agent: 'ZZ Test',
          price: 500_000, comm_type: '%', comm_value: 0, comm_pct: 2.5,
          comm_status: 'Pending', comm_paid_status: 'No',
          adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
          created_at: now, updated_at: now,
        },
      });
      await tx.invoices.create({
        data: {
          transaction_id: t.id, invoice_no: `ZZ-ONLY-${stamp}`, status: 'Unpaid',
          invoice_date: new Date('2026-01-01T00:00:00.000Z'), created_at: now, updated_at: now,
        },
      });

      const loaded = await tx.transactions.findUnique({ where: { id: t.id }, include: txnShowInclude });
      expect((loaded?.invoices ?? []).length).toBe(1);
    });
  }, 60000);
});
