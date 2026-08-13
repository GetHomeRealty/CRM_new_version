import { ForbiddenException } from '@nestjs/common';
import { ROLES } from '../auth/permission.service';
import {
  CAPABILITIES, ROLE_RANK, assertCan, atLeast, can, isAdminOrAbove, isAgent, isSuperAdmin,
  type Capability,
} from './authz';

/**
 * The authorization engine.
 *
 * The whole claim of centralising this is that NO DECISION MOVED — six copies of two rules became
 * one copy, and everyone who could do a thing before can still do it. So the first test states the
 * rules the removed code contained, written out the way it used to be written, and checks the
 * engine agrees for every role the application has.
 */

/** Exactly what the four deleted copies said, kept here as the reference to check against. */
const OLD_IS_SUPER_ADMIN = (role: string) => role === 'admin';
const OLD_IS_ADMIN_OR_ABOVE = (role: string) => role === 'admin' || role === 'manager';
const OLD_IS_AGENT = (role: string) => role === 'agent';

describe('the engine reproduces the checks it replaced', () => {
  it.each([...ROLES])('agrees about %s', (role) => {
    const u = { role };
    expect(isSuperAdmin(u)).toBe(OLD_IS_SUPER_ADMIN(role));
    expect(isAdminOrAbove(u)).toBe(OLD_IS_ADMIN_OR_ABOVE(role));
    expect(isAgent(u)).toBe(OLD_IS_AGENT(role));
  });

  it('knows every role the application has', () => {
    // A role missing from the ladder would rank 0 and be refused everything — safe, but it would
    // refuse silently, so the two lists are pinned to each other.
    expect(Object.keys(ROLE_RANK).sort()).toEqual([...ROLES].sort());
  });
});

describe('nobody unknown gets in', () => {
  it('refuses a missing, empty or unrecognised role', () => {
    for (const u of [null, undefined, {}, { role: null }, { role: '' }, { role: 'wizard' }]) {
      expect(isSuperAdmin(u as never)).toBe(false);
      expect(isAdminOrAbove(u as never)).toBe(false);
      for (const cap of Object.keys(CAPABILITIES) as Capability[]) {
        expect(can(u as never, cap)).toBe(false);
      }
    }
  });

  it('does not let an unknown role satisfy atLeast for anything real', () => {
    for (const role of ROLES) expect(atLeast({ role: 'wizard' }, role)).toBe(false);
  });
});

describe('the ladder is a ladder', () => {
  it('gives an admin everything a manager has, and a manager everything an agent has', () => {
    for (const cap of Object.keys(CAPABILITIES) as Capability[]) {
      if (can({ role: 'agent' }, cap)) expect(can({ role: 'manager' }, cap)).toBe(true);
      if (can({ role: 'manager' }, cap)) expect(can({ role: 'admin' }, cap)).toBe(true);
    }
  });

  it('puts admin at the top', () => {
    const top = Math.max(...Object.values(ROLE_RANK));
    expect(ROLE_RANK.admin).toBe(top);
    expect(Object.entries(ROLE_RANK).filter(([, v]) => v === top).map(([k]) => k)).toEqual(['admin']);
  });
});

describe('the capabilities restate the decisions they came from', () => {
  /** Read off the call sites this replaced, so a change to either side fails here. */
  const EXPECTED: Record<Capability, string[]> = {
    'documents.override-valid': ['admin'],
    'documents.administer': ['admin', 'manager'],
    'transactions.approve-edit': ['admin'],
    'transactions.decide-deletion': ['admin', 'manager'],
    'transactions.override-lock': ['admin'],
    'notifications.administer': ['admin', 'manager'],
    'users.manage-photo': ['admin', 'manager'],
    'users.administer': ['admin'],
    'data.read-all': ['admin', 'manager'],
    /*
     * Everyone below manager is locked out of rewriting a brokerage-assigned lead's identity —
     * including `crm`, `accounting` and `documentation`, which the old `role === 'agent'` check
     * silently exempted. Listing every holder here is the point: the bug was that three roles were
     * on the wrong side of a rule nobody had written down.
     */
    'leads.rewrite-identity': ['admin', 'manager'],
    /*
     * The brokerage's own banking details.
     *
     * `accounting` and `documentation` are IN, and that is deliberate rather than a loose
     * threshold: the five documents that print these numbers — Invoice, Trade Sheet, Notice of
     * Sale, Deposit Receipt, Lawyer Statement — are opened from TransactionDetailPage, which
     * `documentation` reaches on `transactions: 'edit'` and `accounting` reaches for invoicing.
     * Excluding either would break the roles whose job is to produce those documents.
     *
     * `crm` is OUT, which is the finding this replaced: the old `isAgent(user)` check stripped the
     * numbers for agents only, so a role with `transactions: 'none'` and `invoice: 'none'` was
     * handed the operating account and transit numbers on request.
     *
     * `agent` stays OUT, unchanged — an agent works transactions but is not shown brokerage banking.
     */
    'company.read-banking': ['admin', 'manager', 'accounting', 'documentation'],
    /*
     * The brokerage's whole marketing audience: which leads may be SELECTED for a campaign, and the
     * whole opt-out list.
     *
     * THE ONE CAPABILITY DEFINED BY NAMED ROLES RATHER THAN A RANK, because marketing does not run
     * along the seniority ladder. `crm` (rank 40) needs it; `accounting` and `documentation`
     * (rank 60) sit ABOVE it and must not have it — neither runs campaigns nor manages unsubscribes,
     * so neither needs a brokerage-wide list of client email addresses. No threshold can express
     * that, which is why this list is explicit.
     *
     * `agent` is OUT and keeps their own leads only.
     *
     * SELECTION, NOT PERMISSION TO SEND. Holding this widens the candidate pool; it bypasses none of
     * the controls that narrow it. Suppression, the lead's own `unsubscribed` flag, the campaign
     * filters, duplicate removal and malformed-address exclusion all still run, for everyone.
     */
    'campaigns.brokerage-audience': ['admin', 'manager', 'crm'],
  };

  it.each(Object.keys(EXPECTED) as Capability[])('%s is held by exactly the right roles', (cap) => {
    const holders = ROLES.filter((r) => can({ role: r }, cap));
    expect([...holders].sort()).toEqual([...EXPECTED[cap]].sort());
  });

  it('covers every capability the engine defines', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(CAPABILITIES).sort());
  });
});

describe('refusal is consistent', () => {
  it('throws one shape of error, whatever was refused', () => {
    expect(() => assertCan({ role: 'agent' }, 'users.administer')).toThrow(ForbiddenException);
    try {
      assertCan({ role: 'agent' }, 'users.administer');
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toEqual({ message: 'Administrator access required.' });
    }
  });

  it('lets a caller say something more specific when the reason is worth explaining', () => {
    try {
      assertCan({ role: 'agent' }, 'documents.override-valid', 'Only a Super Admin can replace it.');
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toEqual({ message: 'Only a Super Admin can replace it.' });
    }
  });

  it('says nothing at all when the answer is yes', () => {
    expect(() => assertCan({ role: 'admin' }, 'users.administer')).not.toThrow();
  });
});
