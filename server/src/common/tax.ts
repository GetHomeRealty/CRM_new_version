import { marketOf } from './market';

/**
 * THE SALES TAX ON A DEAL'S COMMISSION, BY COUNTRY (India desk, 19 Oct 2026).
 *
 * Canada: HST 13%, exactly as before - every Canadian figure is unchanged.
 * India: GST 18% (Sai, from the accounting team: "Total 18% ... must replace 13%"), split on the
 * invoice into CGST 9% + SGST 9% when our office and the builder are in the same state, or IGST 18%
 * when they are not. The split only changes how the invoice prints the tax; the amount is 18% either way.
 *
 * Every screen, report and dashboard works in ONE country at a time, so a calculation takes the rate
 * of the country it is working in.
 */
export const TAX_RATE = { CA: 0.13, IN: 0.18 } as const;
export const TAX_LABEL = { CA: 'HST', IN: 'GST' } as const;

export const taxRateFor = (market: string | null | undefined): number => TAX_RATE[marketOf({ market })];
export const taxLabelFor = (market: string | null | undefined): string => TAX_LABEL[marketOf({ market })];

/**
 * The divisor that takes a tax-inclusive amount back to its pre-tax part.
 *
 * Canada keeps the LITERAL 1.13 its code has always used: in binary64 `1 + 0.13` is not the same double
 * as `1.13`, and the dashboard's SQL is checked against this code for exact equality.
 */
export const grossDivisorFor = (market: string | null | undefined): number => (marketOf({ market }) === 'IN' ? 1.18 : 1.13);

/**
 * A dashboard/report SQL statement for one country.
 *
 * The SQL is written with Canada's constants (`G`, `HST`, the literal 1.13). Working in India, the same
 * statement is used with India's - one definition of the arithmetic, two rates. Canada: returned as is.
 */
export function sqlForMarket(sql: string, market: string | null | undefined): string {
  if (marketOf({ market }) !== 'IN') return sql;
  return sql
    .split('(1::float8 + 0.13::float8)').join('(1::float8 + 0.18::float8)')
    .split('0.13::float8').join('0.18::float8')
    .split('1.13::float8').join('1.18::float8');
}
