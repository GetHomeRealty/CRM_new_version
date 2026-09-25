import { paidPayoutKeys, hasNewlyPaidPayout } from './payout-collected';

/*
 * TD-107 (carry-forward) - AN AGENT IS NOT PAID OUT OF MONEY THE BROKERAGE HAS NOT COLLECTED, AND
 * THAT MUST HOLD ON A PRECONSTRUCTION DEAL TOO.
 *
 * The guard read admin_activities.agents alone. A preconstruction deal pays through
 * term_admin[termNo].agents, so a term payout could be marked Paid against a deal that had
 * collected nothing. There was no test of this rule of any kind before these.
 */

const pay = (status: string, amount = '5000', date = '2026-09-01') =>
  ({ paid_status: status, amount, paid_date: date });

const ordinary = (status: string) => ({ agents: { Alice: { payments: [pay(status)] } } });
const term = (no: string, status: string) =>
  ({ term_admin: { [no]: { agents: { Alice: { payments: [pay(status)] } } } } });
const twoTerms = () => ({
  term_admin: {
    1: { agents: { Alice: { payments: [pay('Paid')] } } },
    2: { agents: { Alice: { payments: [pay('Paid')] } } },
  },
});

describe('what counts as a recorded payout', () => {
  it('sees a paid row on an ordinary deal, as it always did', () => {
    expect(paidPayoutKeys(ordinary('Paid')).size).toBe(1);
  });

  it('ignores a row that is not Paid', () => {
    expect(paidPayoutKeys(ordinary('Pending')).size).toBe(0);
  });

  it('SEES A PAID ROW ON A PRECONSTRUCTION TERM - the gap this closes', () => {
    expect(paidPayoutKeys(term('1', 'Paid')).size).toBe(1);
  });

  it('keeps two terms apart when they pay one person the same amount on the same day', () => {
    // Keyed without the term number these collapse into one, and the second payout would look
    // like no change at all - the guard would wave through the case it exists to catch.
    expect(paidPayoutKeys(twoTerms()).size).toBe(2);
  });

  it('survives a missing or malformed blob', () => {
    for (const junk of [null, undefined, '', 42, [], { agents: 'nonsense' }, { term_admin: 7 }]) {
      expect(paidPayoutKeys(junk).size).toBe(0);
    }
  });
});

describe('whether a save records a NEW payout', () => {
  it('says no when the same paid row is simply re-saved', () => {
    // Editing any other field on a deal whose agents were legitimately paid must not be refused.
    expect(hasNewlyPaidPayout(ordinary('Paid'), ordinary('Paid'))).toBe(false);
  });

  it('says yes when an ordinary payout is newly marked Paid', () => {
    expect(hasNewlyPaidPayout(ordinary('Pending'), ordinary('Paid'))).toBe(true);
  });

  it('SAYS YES WHEN A PRECONSTRUCTION TERM PAYOUT IS NEWLY MARKED PAID', () => {
    expect(hasNewlyPaidPayout(term('1', 'Pending'), term('1', 'Paid'))).toBe(true);
  });

  it('says yes when a SECOND term pays the same agent the same amount', () => {
    const one = { term_admin: { 1: { agents: { Alice: { payments: [pay('Paid')] } } } } };
    expect(hasNewlyPaidPayout(one, twoTerms())).toBe(true);
  });

  it('says no on a deal with no payouts at all', () => {
    expect(hasNewlyPaidPayout({}, {})).toBe(false);
  });
});
