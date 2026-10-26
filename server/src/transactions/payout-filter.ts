import { Prisma } from '@prisma/client';
import { PAYMENT_STATUS_SQL } from '../reports/report-payments.sql';

/**
 * THE TRANSACTIONS LIST'S "PAYOUT STATUS" FILTER, FROM THE AGENT PAYMENTS (Sai, 26 Oct 2026).
 *
 * The filter used to read `transactions.comm_paid_status`, a column nothing writes: on live it was
 * empty on all 2,885 deals, so "Paid" and "N/A" found nothing and "Pending" found every deal - while
 * the Dashboard showed $9.3M paid. Agent payments are recorded in Admin Activities, and the brokerage
 * already reads them one way: the Transaction Payment Status report's ladder (`PAYMENT_STATUS_SQL`,
 * the SQL form of `agentPaymentStatus`), over the payment cache kept on every save.
 *
 * The filter now asks that same ladder:
 *   Paid    - every agent on the deal is paid (or Agent Payment Readiness says Paid)
 *   Pending - not yet, or only partly (Pending, Partially Paid, Upcoming)
 *   N/A     - no agent commission payable (or Agent Payment Readiness says Not Applicable)
 */
export const PAYOUT_STATUSES: Readonly<Record<string, readonly string[]>> = {
  Paid: ['Paid'],
  Pending: ['Pending', 'Partially Paid', 'Upcoming'],
  'N/A': ['Not Applicable'],
};

/** The ids of the deals in this payout state, as a where-clause. Null when `payout` is not one of the three. */
export async function payoutWhere(
  db: { $queryRaw: <T>(q: Prisma.Sql) => Promise<T> },
  payout: string | undefined,
): Promise<Prisma.transactionsWhereInput | null> {
  const wanted = payout ? PAYOUT_STATUSES[payout] : undefined;
  if (!wanted) return null;
  const rows = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT t.id FROM transactions t
     WHERE t.deleted_at IS NULL AND t.calc_at IS NOT NULL
       AND (${Prisma.raw(PAYMENT_STATUS_SQL)}) IN (${Prisma.join(wanted as string[])})`);
  return { id: { in: rows.map((r) => r.id) } };
}
