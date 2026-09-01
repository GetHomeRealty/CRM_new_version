import { DEFAULT_TRIGGERS } from './crm-settings.constants';
import { CRM_COMMUNICATIONS } from './crm-communications.registry';

/**
 * CRM-021: nothing reaches a client automatically unless the brokerage has said so.
 *
 * WHAT THIS IS. Not a bug fix - a business decision the application had been making on the
 * brokerage's behalf. The CRM sends four emails to CLIENTS on its own initiative (welcome,
 * birthday, anniversary, seasonal) and the only consent it records is the ABSENCE of an
 * unsubscribe. That is opt-out, where Canadian commercial email is generally expected to be
 * opt-in, and whether a given brokerage's leads are covered by implied consent is a question for
 * the brokerage and its advisor. The brokerage was asked on 2026-08-29 and chose: all four off by
 * default, switched on deliberately.
 *
 * WHY THE TEST IS DERIVED FROM THE REGISTRY rather than listing four keys. The rule is "automated,
 * to a lead, defaults to off" - so a FIFTH such communication added later is covered without
 * anybody remembering this file exists. A hard-coded list would pass while the new one shipped on.
 *
 * WHAT IT MUST NOT DO is switch off the manual sends. `promotional`, `referral` and `custom` are
 * dispatched when somebody presses send; their toggle governs availability, not unattended email,
 * and defaulting them off would take away a working feature to solve a consent problem they do not
 * have.
 */

const automatedToLeads = CRM_COMMUNICATIONS.filter((c) => c.kind === 'automated' && c.audience === 'lead');
const manualToLeads = CRM_COMMUNICATIONS.filter((c) => c.kind === 'manual' && c.audience === 'lead');

describe('automated client email is off until the brokerage chooses it', () => {
  it('has the four the report identified, and finds them from the registry', () => {
    // If this number changes, a new client-facing automated email exists and the case below covers
    // it automatically - this assertion is here so the change is noticed rather than silent.
    expect(automatedToLeads.map((c) => c.key).sort()).toEqual(['anniversary', 'birthday', 'seasonal', 'welcome']);
  });

  it('defaults every automated lead-facing email to off', () => {
    for (const comm of automatedToLeads) {
      // THE DECISION: `seasonal` was true; the other three already were false.
      expect(DEFAULT_TRIGGERS[comm.key]).toBe(false);
    }
  });

  it('leaves the manual sends available', () => {
    for (const comm of manualToLeads) {
      expect(DEFAULT_TRIGGERS[comm.key]).toBe(true);
    }
  });

  it('says nothing about staff notifications, which are personal', () => {
    // These have no brokerage layer to inherit from; a default here would be a second answer.
    const staff = CRM_COMMUNICATIONS.filter((c) => c.audience === 'staff');
    expect(staff.length).toBeGreaterThan(0);
    for (const comm of staff) {
      expect(DEFAULT_TRIGGERS).not.toHaveProperty(comm.key);
    }
  });
});
