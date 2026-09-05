import { Prisma } from '@prisma/client';
import type { ListTransactionsDto } from './dto/list-transactions.dto';

/**
 * The transactions screen's filters, expressed as database predicates.
 *
 * These ran in the browser over the full list until the list started paging: with only one page
 * in memory, client-side filtering would have searched a 25-row window and reported that as the
 * whole answer. Each clause below therefore has to reproduce its old predicate exactly, including
 * the parts that look like accidents — an absent status meaning "Open", a null payout counting as
 * "Pending" — because those are what the screen has always shown.
 *
 * `@db.Date` columns come back from Prisma as UTC midnight and were serialised with
 * `toISOString().slice(0, 10)`, so a `YYYY-MM-DD` from a date input compares exactly with no
 * timezone drift in either direction.
 */

/** Parse a `YYYY-MM-DD` filter value to the UTC instant a @db.Date column holds for that day. */
const dateAt = (v: string | undefined): Date | null => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const has = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

export function filterClauses(q: ListTransactionsDto): Prisma.transactionsWhereInput[] {
  const out: Prisma.transactionsWhereInput[] = [];

  /*
   * Free text. The old predicate tested one concatenation of "property trade_no agent", which no
   * relational filter can express; this matches any of the fields instead. The only divergence is
   * a query that straddles two fields ("Main St 1024"), which matched before and does not now.
   *
   * TD-090 — A CLIENT'S NAME FINDS THEIR DEAL.
   *
   * The box searched three columns on `transactions` and nothing else, so a deal carrying two
   * buyers named Nair returned nothing for "Nair" while "Oakridge" and the trade number each
   * returned it. That is the everyday journey: an agent takes a call from a client and has to reach
   * the file by the only thing they know for certain — who is on the phone. The alternative is
   * asking the caller for their own address.
   *
   * The predicate already existed, as the dedicated `client` filter below, so this adds a fourth
   * arm rather than a capability. It is the one arm that crosses a relation: `some` matches a deal
   * with ANY client whose name contains the text, which is what "find me the Nair file" means when
   * a deal has two of them.
   */
  if (has(q.q)) {
    const contains = q.q.trim();
    out.push({
      OR: [
        { property: { contains, mode: 'insensitive' } },
        { trade_no: { contains, mode: 'insensitive' } },
        { agent: { contains, mode: 'insensitive' } },
        { clients: { some: { name: { contains, mode: 'insensitive' } } } },
      ],
    });
  }

  // Year of the closing date. A deal with no closing date belongs to no year and drops out —
  // the `gte`/`lte` pair already excludes NULL, matching the old `dealYear(t) !== f.year`.
  if (has(q.year) && /^\d{4}$/.test(q.year.trim())) {
    const y = q.year.trim();
    out.push({ closing_date: { gte: new Date(`${y}-01-01T00:00:00.000Z`), lte: new Date(`${y}-12-31T00:00:00.000Z`) } });
  }

  if (has(q.type)) out.push({ type: q.type });
  if (has(q.validation)) out.push({ valid_status: q.validation });
  if (has(q.agent)) out.push({ agent: { contains: q.agent.trim(), mode: 'insensitive' } });

  // comm_status is NOT NULL with a default, so a plain inequality is safe here.
  if (q.commission === 'Received') out.push({ comm_status: 'Received' });
  if (q.commission === 'Not received') out.push({ comm_status: { not: 'Received' } });

  // A transaction with no status rows was displayed as "Open" (statusList falls back to it), so
  // filtering by Open has to include those rows as well as rows explicitly marked Open.
  if (has(q.status)) {
    const status = q.status.trim();
    out.push(
      status === 'Open'
        ? { OR: [{ transaction_statuses: { none: {} } }, { transaction_statuses: { some: { status } } }] }
        : { transaction_statuses: { some: { status } } },
    );
  }

  const offerFrom = dateAt(q.offer_from);
  const offerTo = dateAt(q.offer_to);
  if (offerFrom) out.push({ offer_date: { gte: offerFrom } });
  if (offerTo) out.push({ offer_date: { lte: offerTo } });

  const closingFrom = dateAt(q.closing_from);
  const closingTo = dateAt(q.closing_to);
  if (closingFrom) out.push({ closing_date: { gte: closingFrom } });
  if (closingTo) out.push({ closing_date: { lte: closingTo } });

  // Payout. "Pending" was written as `paid !== 'Yes'`, which in JavaScript is true for null and
  // for the empty string. SQL disagrees — `comm_paid_status <> 'Yes'` drops NULL rows — so the
  // null case has to be spelled out or every unset deal would vanish from the Pending filter.
  if (q.payout === 'Paid') out.push({ comm_paid_status: 'Yes' });
  if (q.payout === 'Pending') out.push({ OR: [{ comm_paid_status: null }, { comm_paid_status: { not: 'Yes' } }] });
  if (q.payout === 'N/A') out.push({ comm_paid_status: 'N/A' });

  if (has(q.client)) out.push({ clients: { some: { name: { contains: q.client.trim(), mode: 'insensitive' } } } });
  // brokerages is a to-one relation, so `is` rather than `some`; a deal with no brokerage never
  // matched the old `(t.brokerage?.name || '')` test either.
  if (has(q.brokerage)) out.push({ brokerages: { is: { name: { contains: q.brokerage.trim(), mode: 'insensitive' } } } });

  return out;
}
