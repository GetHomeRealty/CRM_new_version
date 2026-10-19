import type { Prisma } from '@prisma/client';
import type { Request } from 'express';

/**
 * THE COUNTRY A DEAL BELONGS TO, AND THE COUNTRY A PERSON IS WORKING IN (India desk, stage 1, 16 Oct 2026).
 *
 * The brokerage takes on clients buying property in India. Those deals are kept apart from the
 * Canadian ones: same company, same app, same team, but an India deal is seen only by people who
 * have been given India access, and only while they are working in India. Canada is unchanged.
 *
 * Two facts, one on each side:
 *   - `transactions.market` - the deal's country, 'CA' or 'IN'. Every deal before this change is 'CA'.
 *   - `users.markets` - the countries a person may work in, comma-separated. 'CA' for everyone
 *     today; 'CA,IN' once a Super Admin gives them India access; 'IN' for somebody who works on
 *     India deals only (Sai, 17 Oct 2026: "allow india only too... for future purposes").
 *
 * The sign-in remembers which of their countries the person is working in right now (the top-bar
 * switch stores it on the session). `resolveMarket` turns that into ONE country on every request, and
 * every read of deals is narrowed to it - see `transactionScopeWhere` in `transaction-scope.ts`.
 *
 * THE SAFE DIRECTION IS THE PERSON'S OWN FIRST COUNTRY. A request that names no country, or names one
 * the person may not use, works in the first country they were given - Canada for everyone who has
 * Canada, India for an India-only person. A record that carries no country at all (a caller that
 * never learned about countries) is Canada. So a screen that was missed shows exactly what it showed
 * before, and an India deal can only ever appear where India was asked for AND allowed.
 */

export const MARKETS = ['CA', 'IN'] as const;
export type Market = (typeof MARKETS)[number];

export const DEFAULT_MARKET: Market = 'CA';

export const MARKET_LABEL: Record<Market, string> = { CA: 'Canada', IN: 'India' };

export const isMarket = (v: unknown): v is Market => typeof v === 'string' && (MARKETS as readonly string[]).includes(v);

/** The country codes named in a stored or submitted list, unknown ones dropped, in the fixed order. */
export function parseMarkets(list: string | readonly unknown[] | null | undefined): Market[] {
  const raw = Array.isArray(list) ? list.map((c) => String(c)) : String(list ?? '').split(',');
  const codes = new Set(raw.map((c) => c.trim().toUpperCase()).filter(isMarket));
  return MARKETS.filter((m) => codes.has(m));
}

/**
 * The countries a person may work in, from `users.markets`.
 *
 * Unknown codes are dropped and the order is fixed, so 'IN, ca, XX' reads as ['CA', 'IN'], and 'IN'
 * alone is an India-only person. A value naming no country at all is Canada - the column's default and
 * what every account was before countries existed - so a person can never end up with none.
 */
export function allowedMarkets(stored: string | null | undefined): Market[] {
  const codes = parseMarkets(stored);
  return codes.length ? codes : [DEFAULT_MARKET];
}

/**
 * What this sign-in asked for with the top-bar switch, kept on the session (`POST /api/user/market`).
 * Undefined when it never chose - a new sign-in, or a phone-app session, which has no cookie session.
 */
export function requestedMarket(req: Pick<Request, 'session'> | null | undefined): string | undefined {
  const v = req?.session?.market;
  return typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : undefined;
}

/**
 * The one country this request works in: the one asked for if this person may use it, else their
 * first country (Canada for anyone who has Canada; India for an India-only person).
 */
export function resolveMarket(asked: string | undefined, stored: string | null | undefined): Market {
  const allowed = allowedMarkets(stored);
  return isMarket(asked) && allowed.includes(asked) ? asked : allowed[0];
}

/** The country a user record is working in. Anything that never carried one is Canada. */
export function marketOf(user: { market?: string | null } | null | undefined): Market {
  return isMarket(user?.market) ? user!.market as Market : DEFAULT_MARKET;
}

/**
 * The deal types an India deal may have (India desk, 17 Oct 2026). Mostly pre-construction (Sai); the
 * team will name the other kinds, and they are added here then. Canada keeps every type it had.
 */
export const INDIA_TYPES: readonly string[] = ['Preconstruction'];

/** Whether a deal of this type may be in this country. Canada: everything it allowed before. */
export const typeAllowedIn = (market: string | null | undefined, type: string): boolean =>
  marketOf({ market }) !== 'IN' || INDIA_TYPES.includes(type);

/** `t.market = 'CA'` for hand-written SQL. Safe to inline: the value can only be one of `MARKETS`. */
export function marketSql(user: { market?: string | null } | null | undefined, alias = 't'): string {
  return `${alias}.market = '${marketOf(user)}'`;
}

/** "Invoices in this country" as a query term. Canada includes the invoices that have no deal. */
/**
 * The history rows (audit_logs) one country may see (19 Oct 2026). A row tied to a deal follows the
 * deal's country; a row not tied to one follows its own `market` (invoice and Recycle Bin rows), and a
 * row with none - a user account change, a setting - belongs to both.
 */
export function auditMarketWhere(market?: string | null): Prisma.audit_logsWhereInput {
  const m = marketOf({ market });
  return {
    OR: [
      { transaction_id: { not: null }, transactions: { market: m } },
      { transaction_id: null, OR: [{ market: m }, { market: null }] },
    ],
  };
}

export function invoiceMarketWhere(market?: string | null): Prisma.invoicesWhereInput {
  const m = marketOf({ market });
  return m === 'CA'
    ? { OR: [{ transaction_id: null }, { transactions: { market: 'CA' } }] }
    : { transactions: { market: m } };
}
