import { ForbiddenException } from '@nestjs/common';
import { can } from './authz';
import { statusSetProblem, TERMINAL_STATUSES } from '../reference/transaction.constants';
import { InvoiceAccessGuard } from '../invoices/invoice-access.guard';

/**
 * The Transaction Desk remediation rules, asserted where they are decided.
 *
 * Pure rules only — no database. Each of these is a sentence somebody has to be able to rely on,
 * and each was wrong in a way that the screens hid rather than showed.
 */

const ctxFor = (role: string | null) => ({
  switchToHttp: () => ({ getRequest: () => ({ authUser: role === null ? undefined : { id: 1, name: 'X', role } }) }),
}) as never;

describe('the Invoice module is brokerage financial staff only', () => {
  const guard = new InvoiceAccessGuard();

  it.each(['admin', 'manager', 'accounting'])('%s may open it', (role) => {
    expect(can({ role }, 'invoices.access')).toBe(true);
    expect(guard.canActivate(ctxFor(role))).toBe(true);
  });

  /*
   * `documentation` is the reason this is a NAMED SET rather than a rank threshold: it shares
   * `accounting`'s rank of 60, so any threshold admitting Accounting admits it too.
   */
  it.each(['agent', 'crm', 'documentation'])('%s may not, whatever their screen permission says', (role) => {
    expect(can({ role }, 'invoices.access')).toBe(false);
    expect(() => guard.canActivate(ctxFor(role))).toThrow(ForbiddenException);
  });

  it('refuses a role nobody has invented yet', () => {
    // A named set is the stricter form: a role added to ROLE_RANK later inherits threshold
    // capabilities at its rank and inherits none of the named ones without being listed.
    expect(can({ role: 'bookkeeping' }, 'invoices.access')).toBe(false);
  });

  it('refuses an unauthenticated request', () => {
    expect(() => guard.canActivate(ctxFor(null))).toThrow(ForbiddenException);
  });
});

describe('a transaction cannot be in two contradictory end states', () => {
  it('refuses two terminal statuses together', () => {
    expect(statusSetProblem('Residential Buying', ['Closed', 'DFT'])).toMatch(/cannot be .*at the same time/);
    expect(statusSetProblem('Residential Buying', ['Closed', 'Void'])).toMatch(/cannot be/);
    expect(statusSetProblem('Residential Sale Listing', ['Closed', 'Terminated'])).toMatch(/cannot be/);
  });

  it('allows the ordinary end of a listing — Sold AND Closed', () => {
    // `Sold` and `Leased` mark a deal as transacted, not finished, so they are deliberately not
    // terminal. Rejecting this pair would refuse the most common way a listing actually ends.
    expect(statusSetProblem('Residential Sale Listing', ['Sold', 'Closed'])).toBeNull();
    expect(statusSetProblem('Residential Lease Listing', ['Leased', 'Closed'])).toBeNull();
  });

  it('allows a single terminal status, which is the point', () => {
    for (const s of TERMINAL_STATUSES) {
      const type = s === 'Expired' || s === 'Terminated' ? 'Residential Sale Listing' : 'Residential Buying';
      expect(statusSetProblem(type, [s])).toBeNull();
    }
  });

  it('refuses a status the transaction type does not have', () => {
    // `Expired` belongs to the listing lifecycle. A Residential Buying deal has no expiry.
    expect(statusSetProblem('Residential Buying', ['Expired'])).toMatch(/is not a status/);
    // `Secured Firm` belongs to the secured deal types, not to a listing.
    expect(statusSetProblem('Residential Sale Listing', ['Secured Firm'])).toMatch(/is not a status/);
    // Referral has the narrowest vocabulary of all.
    expect(statusSetProblem('Referral', ['DFT'])).toMatch(/is not a status/);
  });

  it('names what is wrong, because somebody has just pressed Save', () => {
    const problem = statusSetProblem('Residential Buying', ['Closed', 'Void']);
    expect(problem).toContain('"Closed"');
    expect(problem).toContain('"Void"');
  });

  it('accepts the ordinary live combinations', () => {
    expect(statusSetProblem('Residential Sale Listing', ['Active'])).toBeNull();
    expect(statusSetProblem('Residential Sale Listing', ['Sold Conditional'])).toBeNull();
    expect(statusSetProblem('Residential Buying', ['Secured Firm'])).toBeNull();
    expect(statusSetProblem('Preconstruction', ['Open'])).toBeNull();
    expect(statusSetProblem('Referral', ['Open'])).toBeNull();
    expect(statusSetProblem('Residential Buying', [])).toBeNull();
  });

  /*
   * `Open` IS REFUSED ON A SECURED DEAL TYPE, and that is correct but load-bearing enough to pin.
   *
   * The secured types (Residential Buying, Residential Lease, Commercial Buying/Lease, Business
   * Buying) deliberately start with NO status — the user picks one — and their vocabulary is
   * Secured Firm / Secured Conditional / Closed / Mutual Release / DFT / Void. There is no `Open`.
   *
   * A deal with no status rows nevertheless READS as `Open`, because `statusList` falls back to it,
   * so the API returns `statuses: ['Open']` and the form holds it. Saving such a deal therefore
   * submits `['Open']` on a type that has no such status — which is exactly why the caller in
   * `TransactionsWriteService.update` validates ONLY when the submitted set differs from the stored
   * one. Unchanged means untouched, and an unresolved historical row stays editable.
   */
  it('refuses Open on a secured deal type — the display fallback is not a status', () => {
    expect(statusSetProblem('Residential Buying', ['Open'])).toMatch(/is not a status/);
  });

  it('does not invent a transition table', () => {
    // Integrity, not workflow: which status may FOLLOW which is a brokerage decision and is
    // deliberately not enforced here. Re-opening a Closed deal is refused by the edit lock rather
    // than by this, and moving straight from Active to Closed is allowed.
    expect(statusSetProblem('Residential Sale Listing', ['Closed'])).toBeNull();
    expect(statusSetProblem('Residential Sale Listing', ['Active'])).toBeNull();
  });
});
