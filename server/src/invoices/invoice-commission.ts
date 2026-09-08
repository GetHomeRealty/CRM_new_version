import { totalCommission } from '../reports/report-financials';

/**
 * TD-146 / TD-151 - THE ONE ANSWER TO "WHAT SHOULD THIS INVOICE BE CHARGING?", for every caller.
 *
 * Three places need this figure and they must never disagree: refreshFromDeal, which WRITES it onto
 * an unsent invoice; the invoice screen, which REPORTS whether the stored figure still matches; and
 * the deal screen, which reports the same thing from the other side. Two copies of one sum is how
 * this system produced TD-066, TD-145 and TD-151 - the last of which zeroed a live invoice - so
 * there is deliberately only one.
 *
 * A term that no longer exists, or one whose commission is not a number, returns null: an
 * unanswered question is not a figure of zero, which was precisely TD-151.
 */
export const invoiceFigure = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function invoiceCommissionFrom(breakdown: Record<string, unknown>, termNo: number | null): number | null {
  const terms = Array.isArray(breakdown.terms) ? (breakdown.terms as Record<string, unknown>[]) : [];
  if (termNo !== null && termNo !== undefined) {
    const term = terms.find((x) => Number(x.term_no) === Number(termNo));
    return term ? invoiceFigure(term.commission) : null;
  }
  return totalCommission(breakdown).commission;
}
