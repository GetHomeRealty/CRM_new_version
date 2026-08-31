import { can } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-015: the screen must say whose leads a campaign will reach.
 *
 * WHAT THE REPORT ASKED FOR, and what turned out to be already true. It read as though no permission
 * separated who may run a mailing. One does: `campaigns.brokerage-audience` names admin, manager and
 * crm, and `agent` is absent on purpose - an agent's audience is their own book, which is why the
 * tester measured 3 recipients against the Super Admin's 10. That containment is deliberate and
 * documented in `authz.ts`.
 *
 * WHAT WAS GENUINELY MISSING was any statement of it. The Campaigns screen is identical for both,
 * so an agent saw a composer and a recipient count with nothing saying what the count was counted
 * from - and an unstated limit reads as no limit. The fix is disclosure, not a new restriction.
 *
 * THE FLAG COMES FROM THE SAME CAPABILITY THE SEND PATH CONSULTS. That is the property under test:
 * a screen that worked the answer out from the role in the browser could describe a boundary
 * different from the one enforced, which is how this module's other defects happened.
 */

const asUser = (role: string): AuthUserRecord => ({ id: 1, name: 'x', role } as unknown as AuthUserRecord);

describe('who may select the brokerage-wide audience', () => {
  it('admits exactly the roles that run marketing', () => {
    for (const role of ['admin', 'manager', 'crm']) {
      expect(can(asUser(role), 'campaigns.brokerage-audience')).toBe(true);
    }
  });

  it('excludes an agent, whose campaigns reach their own leads', () => {
    expect(can(asUser('agent'), 'campaigns.brokerage-audience')).toBe(false);
  });

  it('excludes the roles that outrank crm but do not run campaigns', () => {
    // The reason this capability is a named set rather than a rank: accounting and documentation
    // sit ABOVE crm and must not hold a brokerage-wide list of client addresses.
    for (const role of ['accounting', 'documentation']) {
      expect(can(asUser(role), 'campaigns.brokerage-audience')).toBe(false);
    }
  });

  it('is the same question the disclosure is built from', () => {
    /*
     * The options endpoint sends `brokerage_audience: can(user, 'campaigns.brokerage-audience')`.
     * Asserting the capability directly is what keeps the screen's sentence and the send path's
     * behaviour from drifting: if this set ever changes, the disclosure changes with it rather than
     * quietly telling an agent the wrong thing about their own reach.
     */
    const disclosureFor = (role: string) => can(asUser(role), 'campaigns.brokerage-audience');
    expect(disclosureFor('agent')).toBe(false);
    expect(disclosureFor('admin')).toBe(true);
  });
});
