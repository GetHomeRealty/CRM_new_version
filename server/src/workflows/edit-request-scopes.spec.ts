import { unlocksLockedDeal, UNLOCKING_SCOPE_FILTER } from './edit-request-scopes';

/**
 * TD-159 - an approval means what it says.
 *
 * The property being protected: somebody who may ask for ONE change on a locked deal must not, by
 * having that change approved, also gain the right to edit everything else on it.
 */
describe('which approvals unlock a locked deal', () => {
  it('lets a general edit request through, however the empty scope is stored', () => {
    expect(unlocksLockedDeal(null)).toBe(true);
    expect(unlocksLockedDeal(undefined)).toBe(true);
    expect(unlocksLockedDeal('')).toBe(true);
  });

  it("keeps today's behaviour for a financial request", () => {
    // Not obviously right, and deliberately unchanged: it is what the application does now, and
    // the brokerage has not been asked. Raised separately.
    expect(unlocksLockedDeal('financial')).toBe(true);
  });

  it('does NOT let a Mandatory approval unlock the deal', () => {
    // The one that matters. documentation, accounting and crm can raise this scope, and none of
    // them may edit a DFT or Closed deal.
    expect(unlocksLockedDeal('mandatory')).toBe(false);
  });

  it('refuses any scope invented later until somebody decides it belongs', () => {
    expect(unlocksLockedDeal('something-new')).toBe(false);
  });

  it('asks the database the same question, without a negated null comparison', () => {
    // `{ scope: { not: 'mandatory' } }` would read as correct and exclude the general requests,
    // because `scope <> 'mandatory'` is UNKNOWN when scope is NULL - so the lock could never lift.
    expect(UNLOCKING_SCOPE_FILTER).toEqual({ OR: [{ scope: null }, { scope: 'financial' }] });
    const accepted = UNLOCKING_SCOPE_FILTER.OR.map((o) => o.scope);
    expect(accepted).toContain(null);
    expect(accepted).not.toContain('mandatory');
  });
});
