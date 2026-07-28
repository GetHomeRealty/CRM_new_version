import {
  totalCommission, agentCommission, brokerageCommission, splitRatios, agentLines,
  sum, money, num, advancePayments, cashback, referral, loanRepayments, agentPaymentsPaid,
} from './report-financials';

// A representative 'standard' breakdown (single agent 90/10) with a min_brokerage floor that
// must NOT be counted into the brokerage split totals.
const standardBd = {
  variant: 'standard',
  commission: 10000, hst: 1300, total: 11300,
  min_brokerage: { commission: 200, hst: 26, total: 226 },
  agents: [
    { name: 'Alice', split: 100, agent_pct: 90, brok_pct: 10,
      agent: { commission: 9000, hst: 1170, total: 10170 },
      brokerage: { commission: 1000, hst: 130, total: 1130 } },
  ],
};

// A 'precon' breakdown whose agent lines live under per-term arrays.
const preconBd = {
  variant: 'precon',
  master: { commission: 5000, hst: 650, total: 5650 },
  min_brokerage: { commission: 200, hst: 26, total: 226 },
  terms: [
    { term_no: 1, agents: [{ name: 'Bob', agent_pct: 95, brok_pct: 5, agent: { commission: 2375, hst: 308.75, total: 2683.75 }, brokerage: { commission: 125, hst: 16.25, total: 141.25 } }] },
    { term_no: 2, agents: [{ name: 'Bob', agent_pct: 95, brok_pct: 5, agent: { commission: 2375, hst: 308.75, total: 2683.75 }, brokerage: { commission: 125, hst: 16.25, total: 141.25 } }] },
  ],
};

// A two-agent 'listing' team split.
const listingBd = {
  variant: 'listing',
  totals: { commission: 20000, hst: 2600, total: 22600 },
  min_brokerage: { commission: 499, hst: 64.87, total: 563.87 },
  agents: [
    { name: 'Cara', agent_pct: 85, brok_pct: 15, agent: { commission: 8500, hst: 1105, total: 9605 }, brokerage: { commission: 1500, hst: 195, total: 1695 } },
    { name: 'Dan', agent_pct: 70, brok_pct: 30, agent: { commission: 7000, hst: 910, total: 7910 }, brokerage: { commission: 3000, hst: 390, total: 3390 } },
  ],
};

describe('report-financials — commission extraction', () => {
  it('total commission (§9A) per variant', () => {
    expect(totalCommission(standardBd)).toEqual({ commission: 10000, hst: 1300, total: 11300 });
    expect(totalCommission(preconBd)).toEqual({ commission: 5000, hst: 650, total: 5650 });
    expect(totalCommission(listingBd)).toEqual({ commission: 20000, hst: 2600, total: 22600 });
  });

  it('agent commission totals (§9B) sum all split agents, incl. flattened precon terms', () => {
    expect(agentCommission(standardBd)).toEqual({ commission: 9000, hst: 1170, total: 10170 });
    expect(agentCommission(preconBd)).toEqual({ commission: 4750, hst: 617.5, total: 5367.5 });
    expect(agentCommission(listingBd)).toEqual({ commission: 15500, hst: 2015, total: 17515 });
  });

  it('brokerage totals (§9D) EXCLUDE the Minimum Brokerage Commission floor', () => {
    // 1000 from the split, never the 200 min-brokerage floor
    expect(brokerageCommission(standardBd)).toEqual({ commission: 1000, hst: 130, total: 1130 });
    expect(brokerageCommission(preconBd)).toEqual({ commission: 250, hst: 32.5, total: 282.5 });
    expect(brokerageCommission(listingBd)).toEqual({ commission: 4500, hst: 585, total: 5085 });
  });

  it('does not double-count: agent + brokerage split == total (standard)', () => {
    const a = agentCommission(standardBd), b = brokerageCommission(standardBd), t = totalCommission(standardBd);
    expect(money(a.total + b.total)).toBe(t.total);
  });

  it('discovers split ratios dynamically (not hardcoded)', () => {
    expect(splitRatios(standardBd)).toEqual(['90/10']);
    expect(splitRatios(listingBd).sort()).toEqual(['70/30', '85/15']);
  });

  it('flattens agent lines across variants', () => {
    expect(agentLines(standardBd)).toHaveLength(1);
    expect(agentLines(preconBd)).toHaveLength(2); // two terms, one agent each
    expect(agentLines(listingBd)).toHaveLength(2);
  });
});

describe('report-financials — decimal safety & edge cases', () => {
  it('sum() is decimal-safe (no float drift)', () => {
    expect(sum([0.1, 0.2])).toBe(0.3);
    expect(sum([1000.1, 2000.2, 3000.3])).toBe(6000.6);
    expect(sum([])).toBe(0);
  });
  it('num() tolerates "$1,234.50" strings and missing values', () => {
    expect(num('$1,234.50')).toBe(1234.5);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num('garbage')).toBe(0);
  });
  it('missing HST / zero commission → zeros, never NaN', () => {
    const bd = { variant: 'standard', commission: 0, total: 0, agents: [], min_brokerage: {} };
    expect(totalCommission(bd)).toEqual({ commission: 0, hst: 0, total: 0 });
    expect(agentCommission(bd)).toEqual({ commission: 0, hst: 0, total: 0 });
    expect(brokerageCommission(bd)).toEqual({ commission: 0, hst: 0, total: 0 });
  });
  it('money() rounds half-up to 2dp', () => {
    expect(money(2.005)).toBe(2.01);
    expect(money(1.005)).toBe(1.01);
    expect(money(1.004)).toBe(1);
  });
});

describe('report-financials — transaction JSON parsers', () => {
  it('advance payments sum & scope by agent', () => {
    const adj = { advance_payment: 'Yes', advance_rows: [{ agent: 'Alice', amount: 500, paid_date: '2026-01-10' }, { agent: 'Bob', amount: 300, paid_date: '2026-02-01' }] };
    expect(advancePayments(adj, null)).toEqual({ total: 800, lastDate: '2026-02-01' });
    expect(advancePayments(adj, ['Alice'])).toEqual({ total: 500, lastDate: '2026-01-10' });
    expect(advancePayments({ advance_payment: 'No', advance_rows: [{ amount: 999 }] }, null)).toEqual({ total: 0, lastDate: null });
  });
  it('client cashback totals paid vs pending', () => {
    const adj = { client_referral: 'Yes', client_rows: [{ client_name: 'X', amount: 1000, paid_status: 'Paid', paid_date: '2026-03-01' }, { client_name: 'Y', amount: 500, paid_status: 'Pending' }] };
    const cb = cashback(adj);
    expect(cb.total).toBe(1500);
    expect(cb.paidTotal).toBe(1000);
    expect(cb.pendingTotal).toBe(500);
  });
  it('external referral computes HST at 13% and total', () => {
    const r = referral({ ext_referral: 'Yes', ext: { brokerage: 'ABC Realty', pct: 25, amount: 2000, paid_status: 'Paid', paid_date: '2026-04-01' } });
    expect(r).toEqual({ party: 'ABC Realty', pct: 25, amount: 2000, hst: 260, total: 2260, paid_date: '2026-04-01', status: 'Completed' });
    expect(referral({ ext_referral: 'No' })).toBeNull();
  });
  it('agent-paid detection from admin_activities (paid_status === Paid)', () => {
    const admin = { agents: { Alice: { payments: [{ paid_status: 'Paid', amount: 4000, paid_date: '2026-05-02' }, { paid_status: 'Pending', amount: 1000 }] } } };
    const p = agentPaymentsPaid(admin, ['Alice']);
    expect(p.totalPaid).toBe(4000);
    expect(p.anyPaid).toBe(true);
    expect(p.lastPaidDate).toBe('2026-05-02');
    expect(agentPaymentsPaid(admin, ['Nobody'])).toEqual({ totalPaid: 0, lastPaidDate: null, anyPaid: false, paidNames: [] });
  });
  it('reads Prisma Decimal columns instead of zeroing them', () => {
    // Prisma returns Decimal objects for numeric columns (price, comm_pct, comm_amt).
    // Treating an object as 0 silently blanked Price and "Commission % / Amount".
    const decimal = (s: string) => ({ toString: () => s, valueOf: () => s });
    expect(num(decimal('900000'))).toBe(900000);
    expect(num(decimal('2.5'))).toBe(2.5);
    expect(num(decimal('0'))).toBe(0);
    expect(num(decimal('1234567.89'))).toBe(1234567.89);   // full stored precision
    // non-numeric objects still collapse to 0 rather than NaN
    expect(num({})).toBe(0);
    expect(num([1, 2])).toBe(0);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num(true)).toBe(0);
  });
  it('tracks which agents are paid, so partial team payment is detectable', () => {
    const admin = { agents: {
      Alice: { payments: [{ paid_status: 'Paid', amount: 100, paid_date: '2026-01-02' }] },
      Bob: { payments: [{ paid_status: 'Pending', amount: 50 }] },
    } };
    const p = agentPaymentsPaid(admin, ['Alice', 'Bob']);
    expect(p.paidNames).toEqual(['Alice']);          // some, not all → "Partially Paid"
    expect(p.anyPaid).toBe(true);
    expect(p.totalPaid).toBe(100);                   // pending rows never count toward paid
  });
  it('loan repayments only count is_loan rows for the given agent', () => {
    const adj = { agent_adjust: 'Yes', adjustment_rows: [{ agent: 'Alice', amount: 200, is_loan: true }, { agent: 'Alice', amount: 999, is_loan: false }, { agent: 'Bob', amount: 100, is_loan: true }] };
    expect(loanRepayments(adj, 'Alice')).toEqual([{ amount: 200 }]);
    expect(loanRepayments(adj, 'Bob')).toEqual([{ amount: 100 }]);
    expect(loanRepayments({ agent_adjust: 'No', adjustment_rows: [] }, 'Alice')).toEqual([]);
  });
});
