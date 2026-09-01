import Decimal from 'decimal.js';

/**
 * Decimal-safe financial extraction for the Reports module. Pure functions over the
 * CommissionService.breakdown() output + parsed transaction JSON. No floating-point
 * accumulation: every sum runs through decimal.js and rounds to 2dp (currency) at the end.
 */

export interface Triple { commission: number; hst: number; total: number }
export const ZERO_TRIPLE: Triple = { commission: 0, hst: 0, total: 0 };
const HST_RATE = 0.13;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Coerce to a finite number (missing/garbage → 0), tolerating "1,234.50" style strings. */
export const num = (v: unknown): number => {
  if (v === null || v === undefined || typeof v === 'boolean' || Array.isArray(v)) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') { const n = Number(v.replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; }
  // Prisma returns Decimal objects for numeric columns (price, comm_pct, comm_amt, …).
  // They stringify to their exact value, so go through the string form rather than
  // dropping them to 0 — full stored precision is preserved and rounded only on display.
  if (typeof v === 'object') { const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; }
  return 0;
};
/** Round to 2 decimals, decimal-safe (half-up), returning a JS number. */
export const money = (v: Decimal.Value): number => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
/** Sum a list of numbers decimal-safe. */
export const sum = (vals: (number | null | undefined)[]): number =>
  money(vals.reduce<Decimal>((a, v) => a.plus(new Decimal(num(v))), new Decimal(0)));

const tripleOf = (v: unknown): Triple => {
  const o = obj(v);
  return { commission: num(o.commission), hst: num(o.hst), total: num(o.total) };
};
export const addTriple = (a: Triple, b: Triple): Triple => ({
  commission: money(new Decimal(a.commission).plus(b.commission)),
  hst: money(new Decimal(a.hst).plus(b.hst)),
  total: money(new Decimal(a.total).plus(b.total)),
});

/** Every agent split line across breakdown variants (precon flattens its per-term agents). */
export function agentLines(bd: Obj): Obj[] {
  if (bd.variant === 'precon') return arr(bd.terms).flatMap((t) => arr(obj(t).agents).map(obj));
  return arr(bd.agents).map(obj);
}

/** Transaction total commission (§9A) — authoritative from the breakdown, per variant. */
export function totalCommission(bd: Obj): Triple {
  if (bd.variant === 'listing') return tripleOf(bd.totals);
  if (bd.variant === 'precon') return tripleOf(bd.master);
  return { commission: num(bd.commission), hst: num(bd.hst), total: num(bd.total) };
}

/**
 * The co-op side, which on a LISTING is paid OUT to the co-operating brokerage.
 *
 * TD-072 and TD-105: both reports printed the deal's TOTAL commission beside agent and brokerage
 * shares taken from the listing side, and omitted this figure. The row then looked as though money
 * had gone missing, and both defects were raised as the agent being underpaid from one side only.
 * THEY ARE NOT. commission.service.ts divides `splitTotal` - the listing side - precisely because
 * the co-op side is not the brokerage's money, and its own balance_check reconciles to the cent.
 * What was missing was this column, not the cash. Paying agents from the combined pool instead
 * would hand them money the brokerage never received.
 *
 * Zero for every other variant: on a buying deal the brokerage RECEIVES the co-op side rather than
 * paying it, and a preconstruction deal has no co-op side at all.
 */
export function coopPayout(bd: Obj): Triple {
  if (bd.variant !== 'listing') return { ...ZERO_TRIPLE };
  return tripleOf(bd.coop);
}

/** Agent commission totals (§9B) — sum of every split agent's agent-side commission. */
export function agentCommission(bd: Obj): Triple {
  return agentLines(bd).reduce<Triple>((acc, l) => addTriple(acc, tripleOf(l.agent)), { ...ZERO_TRIPLE });
}

/**
 * Brokerage commission totals (§9D) — sum of every split agent's brokerage-side commission,
 * EXCLUDING the Minimum Brokerage Commission (which is the separate `min_brokerage` block and
 * is intentionally never folded into these split totals).
 */
export function brokerageCommission(bd: Obj): Triple {
  return agentLines(bd).reduce<Triple>((acc, l) => addTriple(acc, tripleOf(l.brokerage)), { ...ZERO_TRIPLE });
}

/** Distinct agent/brokerage split ratios present on the transaction, e.g. ["90/10"]. */
export function splitRatios(bd: Obj): string[] {
  const set = new Set<string>();
  for (const l of agentLines(bd)) {
    const a = num(l.agent_pct), b = num(l.brok_pct);
    if (a || b) set.add(`${trimPct(a)}/${trimPct(b)}`);
  }
  return [...set];
}
const trimPct = (n: number): string => (Number.isInteger(n) ? String(n) : String(money(n)));

/** Agent names attached to the split. */
export function agentNames(bd: Obj): string[] {
  return agentLines(bd).map((l) => String(l.name ?? '')).filter((n) => n !== '');
}

// ---- transaction JSON parsers (admin_activities / adjustments / activity_tracker) ----

export interface AgentPaymentInfo { totalPaid: number; lastPaidDate: string | null; anyPaid: boolean; paidNames: string[] }

/**
 * Agent commission actually paid, from admin_activities.agents[name].payments[] where
 * paid_status === 'Paid' (the authoritative source the dashboard uses). Scoped to the
 * given split-agent names.
 */
export function agentPaymentsPaid(adminActivities: Obj, names: string[]): AgentPaymentInfo {
  const agents = obj(adminActivities.agents);
  let total = new Decimal(0), last: string | null = null, anyPaid = false;
  const paidNames: string[] = [];
  for (const name of names) {
    const rec = obj(agents[name]);
    let namePaid = false;
    for (const p of arr(rec.payments).map(obj)) {
      if (String(p.paid_status) === 'Paid') {
        anyPaid = namePaid = true;
        total = total.plus(num(p.amount));
        const d = p.paid_date ? String(p.paid_date) : null;
        if (d && (!last || d > last)) last = d;
      }
    }
    if (namePaid) paidNames.push(name);
  }
  return { totalPaid: money(total), lastPaidDate: last, anyPaid, paidNames };
}

export interface AdvanceInfo { total: number; lastDate: string | null }
/** Advance payments (adjustments.advance_rows[] when advance_payment === 'Yes'), scoped to names. */
export function advancePayments(adjustments: Obj, names: string[] | null): AdvanceInfo {
  if (String(adjustments.advance_payment) !== 'Yes') return { total: 0, lastDate: null };
  let total = new Decimal(0), last: string | null = null;
  for (const r of arr(adjustments.advance_rows).map(obj)) {
    if (names && r.agent !== undefined && !names.includes(String(r.agent))) continue;
    total = total.plus(num(r.amount));
    const d = r.paid_date ? String(r.paid_date) : null;
    if (d && (!last || d > last)) last = d;
  }
  return { total: money(total), lastDate: last };
}

export interface CashbackInfo { rows: { client_name: string | null; amount: number; paid_date: string | null; status: string }[]; total: number; paidTotal: number; pendingTotal: number }
/** Client cashback (adjustments.client_rows[] when client_referral === 'Yes'). No scheduled date exists. */
export function cashback(adjustments: Obj): CashbackInfo {
  if (String(adjustments.client_referral) !== 'Yes') return { rows: [], total: 0, paidTotal: 0, pendingTotal: 0 };
  const rows = arr(adjustments.client_rows).map(obj).map((r) => ({
    client_name: r.client_name != null ? String(r.client_name) : null,
    amount: num(r.amount),
    paid_date: r.paid_date ? String(r.paid_date) : null,
    status: String(r.paid_status) === 'Paid' ? 'Completed' : 'Pending',
  }));
  return {
    rows,
    total: sum(rows.map((r) => r.amount)),
    paidTotal: sum(rows.filter((r) => r.status === 'Completed').map((r) => r.amount)),
    pendingTotal: sum(rows.filter((r) => r.status !== 'Completed').map((r) => r.amount)),
  };
}

export interface ReferralInfo { party: string | null; pct: number | null; amount: number; hst: number; total: number; paid_date: string | null; status: string }
/** External brokerage referral (adjustments.ext when ext_referral === 'Yes'); HST computed at 13%. */
export function referral(adjustments: Obj): ReferralInfo | null {
  if (String(adjustments.ext_referral) !== 'Yes') return null;
  const e = obj(adjustments.ext);
  const amount = num(e.amount);
  const hst = money(new Decimal(amount).times(HST_RATE));
  return {
    party: e.brokerage != null && String(e.brokerage) !== '' ? String(e.brokerage) : null,
    pct: e.pct != null && String(e.pct) !== '' ? num(e.pct) : null,
    amount,
    hst,
    total: money(new Decimal(amount).plus(hst)),
    paid_date: e.paid_date ? String(e.paid_date) : null,
    status: String(e.paid_status) === 'Paid' ? 'Completed' : 'Pending',
  };
}

/** Loan repayments recorded against this transaction (adjustments.adjustment_rows[] with is_loan). */
export function loanRepayments(adjustments: Obj, name: string): { amount: number }[] {
  if (String(adjustments.agent_adjust) !== 'Yes') return [];
  return arr(adjustments.adjustment_rows).map(obj)
    .filter((r) => r.is_loan && String(r.agent) === name)
    .map((r) => ({ amount: num(r.amount) }));
}
