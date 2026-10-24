import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { TransactionsWriteService, closedAdjustmentProblem } from './transactions-write.service';

/**
 * A Closed adjustment row stays as it was paid (Madhu, 2026-10-23).
 *
 * "Shows automatic closed after agent payment paid no adjustment fields should work." A row's
 * Status turns Closed by itself once its agent is paid, but every field on it went on working —
 * and the server accepted any change — so an agent's adjustment could be altered after the money
 * had gone out on it. Agreed: the whole row locks, no new row for a paid agent, and Accounting and
 * Super Admin can still correct one.
 */

const PAID = 'Vishnu Boda';
const OPEN = 'Asha Open';
const paid = (a: string) => a === PAID;
const closedRow = { agent: PAID, amount: 653, status: 'Closed', remarks: '', is_loan: false };
const openRow = { agent: OPEN, amount: 200, status: 'Yet to Adjust', remarks: '', is_loan: false };
const on = (...rows: Record<string, unknown>[]) => ({ agent_adjust: 'Yes', adjustment_rows: rows });

describe('the rule: a Closed adjustment row cannot change', () => {
  it('lets a save through that keeps the Closed row as it is', () => {
    expect(closedAdjustmentProblem(on(closedRow, openRow), on(closedRow, openRow), paid)).toBeNull();
  });

  it('ignores Status, and the shapes the form sends for the same values', () => {
    // The form posts amount as a string and leaves remarks/is_loan unset on rows it never touched.
    const sameAsForm = { agent: PAID, amount: '653', status: '' };
    expect(closedAdjustmentProblem(on(closedRow), on(sameAsForm), paid)).toBeNull();
  });

  it('refuses a changed amount — the reported case', () => {
    expect(closedAdjustmentProblem(on(closedRow), on({ ...closedRow, amount: 600 }), paid)).toMatch(/Closed.*can't be changed/);
  });

  it('refuses flipping the sign, the loan tick or the remarks', () => {
    for (const patch of [{ amount: -653 }, { is_loan: true }, { remarks: 'edited' }]) {
      expect(closedAdjustmentProblem(on(closedRow), on({ ...closedRow, ...patch }), paid)).not.toBeNull();
    }
  });

  it('refuses deleting the row, re-pointing it at another agent, or switching Agent Adjust off', () => {
    expect(closedAdjustmentProblem(on(closedRow, openRow), on(openRow), paid)).toMatch(/can't be removed/);
    expect(closedAdjustmentProblem(on(closedRow), on({ ...closedRow, agent: OPEN }), paid)).toMatch(/can't be removed/);
    expect(closedAdjustmentProblem(on(closedRow), { agent_adjust: 'No', adjustment_rows: [] }, paid)).toMatch(/can't be removed/);
  });

  it('refuses a new row for an agent who is already paid', () => {
    expect(closedAdjustmentProblem(on(), on({ agent: PAID, amount: 100 }), paid)).toMatch(/already been paid.*new adjustment/);
    expect(closedAdjustmentProblem(on(closedRow), on(closedRow, { agent: PAID, amount: 100 }), paid)).toMatch(/new adjustment/);
  });

  it('leaves rows for unpaid agents fully editable, and the Closed row may move up the list', () => {
    expect(closedAdjustmentProblem(on(openRow, closedRow), on(closedRow, { ...openRow, amount: 999 }), paid)).toBeNull();
    expect(closedAdjustmentProblem(on(openRow, closedRow), on(closedRow), paid)).toBeNull();
  });

  it('does nothing on a deal where nobody is paid', () => {
    expect(closedAdjustmentProblem(on(closedRow), on({ ...closedRow, amount: 1 }), () => false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Through the real save
// ---------------------------------------------------------------------------

/** One save through `TransactionsWriteService.update` against stubs; returns what it threw. */
const save = async (role: string, stored: Record<string, unknown>, sent: Record<string, unknown>): Promise<unknown> => {
  const txn = {
    id: 1838, trade_no: '201838', type: 'Residential Buying', deleted_at: null,
    price: 500_000, deposit: 0, agent: PAID, agent_user_id: 7, property: '1 Test Road', version: 1,
    offer_date: null, closing_date: null, listing_expiry_date: null, comm_paid_status: null,
    // Vishnu's commission is marked Paid in Admin Activities → Agent Commission Paid.
    admin_activities: JSON.stringify({ agents: { [PAID]: { payments: [{ paid_status: 'Paid' }] } } }),
    activity_tracker: null, adjustments: JSON.stringify(stored),
    updated_at: new Date('2026-09-01T10:00:00.000Z'),
  };
  const tx = {
    transactions: { update: async () => txn, updateMany: async () => ({ count: 1 }), findUnique: async () => txn },
    trashed_row_items: { create: async () => ({ id: 1 }) },
  };
  const prismaStub = {
    transactions: { findFirst: async () => txn, findUnique: async () => txn },
    transaction_statuses: { findMany: async () => [] },
    company_settings: { findUnique: async () => ({ feature_flags: null }) },
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  } as never;
  const audit = { snapshot: async () => ({}), record: async () => undefined, recordChanges: async () => [] } as never;
  const svc = new TransactionsWriteService(
    ...([prismaStub, {}, audit, ...Array.from({ length: 7 }, () => ({}))] as unknown as ConstructorParameters<typeof TransactionsWriteService>),
  );
  // The stubs run out after the write; only a refusal from the guard matters here.
  try { await svc.update({ id: 1, name: 'QA', role } as never, 1838, sent); return null; } catch (e) { return e; }
};
const isLockRefusal = (e: unknown) => e instanceof ForbiddenException && /Closed|already been paid/.test(JSON.stringify(e.getResponse()));

describe('saving a Closed adjustment row', () => {
  const edited = { adjustments: on({ ...closedRow, amount: 600 }) };

  it('is refused for an Admin (manager) with a 403 naming the agent', async () => {
    const e = await save('manager', on(closedRow), edited);
    expect(isLockRefusal(e)).toBe(true);
    expect(JSON.stringify((e as ForbiddenException).getResponse())).toContain(PAID);
  });

  it('is let through for Accounting and for a Super Admin, who may still correct it', async () => {
    expect(isLockRefusal(await save('accounting', on(closedRow), edited))).toBe(false);
    expect(isLockRefusal(await save('admin', on(closedRow), edited))).toBe(false);
  });

  it('works out "paid" from the deal as stored, not from the Status the client sends', async () => {
    // A client that posts the row back as "Yet to Adjust" does not unlock it.
    expect(isLockRefusal(await save('manager', on(closedRow), { adjustments: on({ ...closedRow, amount: 1, status: 'Yet to Adjust' }) }))).toBe(true);
  });

  it('does not stop an ordinary save that leaves the Closed row alone', async () => {
    expect(isLockRefusal(await save('manager', on(closedRow), { adjustments: on(closedRow, openRow) }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The half the user sees
// ---------------------------------------------------------------------------

describe('the panel locks a Closed row', () => {
  const source = readFileSync(join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'AdjustmentModal.tsx'), 'utf8');

  it('disables a locked row and hides its delete button', () => {
    expect(source).toMatch(/<fieldset disabled=\{locked\}/);
    expect(source).toMatch(/!locked && <button className="row-rm"/);
  });

  it('lets the same two roles through as the server', () => {
    expect(source).toMatch(/isSuperAdmin \|\| user\?\.role === 'accounting'/);
  });
});
