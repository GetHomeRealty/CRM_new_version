/**
 * WHICH AGENT PAYOUTS A DEAL RECORDS AS PAID - ON BOTH HALVES OF IT.
 *
 * admin_activities keeps payouts in two places: `agents` on an ordinary deal, and
 * `term_admin[termNo].agents` on a preconstruction deal, where each term pays its own people.
 * Every other walker in transactions-write.service.ts reads both - paidAgentNames does, and so
 * does the audit scan that records payment rows. The TD-107 payout guard read only the first, so
 * on a preconstruction deal a term payout could be recorded as Paid against a deal that had
 * collected nothing - the one thing that guard exists to prevent.
 *
 * IT LIVES IN ITS OWN FILE SO IT CAN BE TESTED. The guard is inline in a save path hundreds of
 * lines long and had no test of any kind: a rule deciding whether an agent may be paid, with
 * nothing asserting it.
 *
 * THE TERM NUMBER IS PART OF THE KEY, which is load-bearing rather than tidy. Two terms paying the
 * same agent the same amount on the same day are two payouts; keyed without the term they collapse
 * into one, and adding the second would look like no change at all - so the guard would wave
 * through the very case it is being extended to catch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A key for every payout row currently marked Paid, across ordinary agents and every term. */
export function paidPayoutKeys(blob: unknown): Set<string> {
  const out = new Set<string>();
  const scan = (agents: Record<string, unknown>, term: string): void => {
    for (const [name, info] of Object.entries(agents)) {
      for (const pay of arr(obj(info).payments)) {
        const p = obj(pay);
        if (String(p.paid_status) === 'Paid') {
          out.add([term, name, JSON.stringify(p.paid_date ?? ''), String(p.amount ?? '')].join('|'));
        }
      }
    }
  };
  const admin = obj(blob);
  scan(obj(admin.agents), '');
  for (const [no, term] of Object.entries(obj(admin.term_admin))) scan(obj(obj(term).agents), no);
  return out;
}

/** True when `after` marks a payout Paid that `before` did not. Re-saving a paid row is not a move. */
export function hasNewlyPaidPayout(before: unknown, after: unknown): boolean {
  const was = paidPayoutKeys(before);
  return [...paidPayoutKeys(after)].some((k) => !was.has(k));
}
