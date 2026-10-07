import { agentPaymentsPaid } from './report-financials';

/*
 * TD-174 - AN AGENT'S RECORDED PAYMENTS ARE COUNTED ONCE, HOWEVER MANY TERMS THEY APPEAR ON.
 *
 * On a preconstruction deal the agent-name list repeats a member once per payment term, on purpose:
 * the payment STATUS compares "how many names are paid" with "how many names there are", so both
 * lists must keep the repeats. But the MONEY was added once per repeat, so an agent on a three-term
 * deal with one $1,000 payment showed "Agent Paid $3,000" in the reports.
 */
const admin = { agents: {
  Asha: { payments: [{ paid_status: 'Paid', amount: 1000, paid_date: '2026-09-01' }, { paid_status: 'Pending', amount: 500 }] },
  Ravi: { payments: [{ paid_status: 'Paid', amount: 250, paid_date: '2026-09-15' }] },
} };

describe('Agent Paid on a multi-term deal', () => {
  it('adds each agent\'s payments once, not once per term', () => {
    expect(agentPaymentsPaid(admin, ['Asha', 'Asha', 'Asha']).totalPaid).toBe(1000);
    expect(agentPaymentsPaid(admin, ['Asha', 'Ravi', 'Asha', 'Ravi']).totalPaid).toBe(1250);
  });
  it('keeps the per-term repeats in paidNames, which the payment status counts against the names', () => {
    expect(agentPaymentsPaid(admin, ['Asha', 'Asha', 'Asha']).paidNames).toEqual(['Asha', 'Asha', 'Asha']);
  });
  it('is unchanged for an ordinary deal with each name once', () => {
    const r = agentPaymentsPaid(admin, ['Asha', 'Ravi']);
    expect(r).toEqual({ totalPaid: 1250, lastPaidDate: '2026-09-15', anyPaid: true, paidNames: ['Asha', 'Ravi'] });
  });
});
