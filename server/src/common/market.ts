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
 *   - `users.markets` - the countries a person may work in, comma-separated. 'CA' for everyone;
 *     'CA,IN' once a Super Admin gives them India access.
 *
 * The sign-in remembers which of their countries the person is working in right now (the top-bar
 * switch stores it on the session). `resolveMarket` turns that into ONE country on every request, and
 * every read of deals is narrowed to it - see `transactionScopeWhere` in `transaction-scope.ts`.
 *
 * THE SAFE DIRECTION IS CANADA. A request that names no country, names one the person may not use,
 * or comes from a caller that never learned about countries, is treated as Canada. So a screen that
 * was missed shows exactly what it showed before, and an India deal can only ever appear where India
 * was asked for AND allowed.
 */

export const MARKETS = ['CA', 'IN'] as const;
export type Market = (typeof MARKETS)[number];

export const DEFAULT_MARKET: Market = 'CA';

export const MARKET_LABEL: Record<Market, string> = { CA: 'Canada', IN: 'India' };

export const isMarket = (v: unknown): v is Market => typeof v === 'string' && (MARKETS as readonly string[]).includes(v);

/**
 * The countries a person may work in, from `users.markets`.
 *
 * Unknown codes are dropped and the order is fixed, so 'IN, ca, XX' reads as ['CA', 'IN'].
 * Canada is always included: every account works on Canadian deals today, and taking Canada away
 * from somebody is not something this column is for.
 */
export function allowedMarkets(stored: string | null | undefined): Market[] {
  const codes = new Set(
    String(stored ?? '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(isMarket),
  );
  codes.add(DEFAULT_MARKET);
  return MARKETS.filter((m) => codes.has(m));
}

/**
 * What this sign-in asked for with the top-bar switch, kept on the session (`POST /api/user/market`).
 * Undefined when it never chose - a new sign-in, or a phone-app session, which has no cookie session.
 */
export function requestedMarket(req: Pick<Request, 'session'> | null | undefined): string | undefined {
  const v = req?.session?.market;
  return typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : undefined;
}

/** The one country this request works in: the one asked for if this person may use it, else Canada. */
export function resolveMarket(asked: string | undefined, stored: string | null | undefined): Market {
  const allowed = allowedMarkets(stored);
  return isMarket(asked) && allowed.includes(asked) ? asked : DEFAULT_MARKET;
}

/** The country a user record is working in. Anything that never carried one is Canada. */
export function marketOf(user: { market?: string | null } | null | undefined): Market {
  return isMarket(user?.market) ? user!.market as Market : DEFAULT_MARKET;
}

/** `t.market = 'CA'` for hand-written SQL. Safe to inline: the value can only be one of `MARKETS`. */
export function marketSql(user: { market?: string | null } | null | undefined, alias = 't'): string {
  return `${alias}.market = '${marketOf(user)}'`;
}

/** "Invoices in this country" as a query term. Canada includes the invoices that have no deal. */
export function invoiceMarketWhere(market?: string | null): Prisma.invoicesWhereInput {
  const m = marketOf({ market });
  return m === 'CA'
    ? { OR: [{ transaction_id: null }, { transactions: { market: 'CA' } }] }
    : { transactions: { market: m } };
}
