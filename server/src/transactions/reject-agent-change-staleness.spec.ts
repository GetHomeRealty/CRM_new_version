import { TransactionsWriteService } from './transactions-write.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * TD-038 — rejecting an agent's change must never overwrite a value somebody has changed since.
 *
 * THE DEFECT THE COMMENT IN `rejectAgentChange` DESCRIBES. Two values comparing equal does not mean
 * nothing happened in between: a field changed away and back reads identical, but the agent's
 * pending edit is no longer what is standing, and reverting "to be safe" would silently erase
 * whatever replaced it. The audit ids answer a question values cannot.
 *
 * The guard exists and reads convincingly in the source. WHAT WAS MISSING is a test that actually
 * drives each of the three ways it can trip — nothing in this codebase called `rejectAgentChange`
 * directly before this file. A comment explaining a safety check is not evidence the check runs.
 *
 * THE THREE GUARDS, each pinned on its own:
 *   NEWER      — an audit entry for the same field, written after this one, exists.
 *   PENDING    — an earlier unhandled Agent change to the same field is still awaiting its own
 *                decision; rejecting this one first would let a revert land out of order.
 *   MOVED      — belt and braces for a write that reached the column without an audit entry: the
 *                field's CURRENT value no longer matches what this change recorded.
 *   GROUPED    — a multi-row family (Client #1, Condition #2, …) is checked as a whole: a sibling
 *                subfield changing since blocks rejecting any one of them, because rejecting removes
 *                the entire row.
 *
 * NO DATABASE. `prisma` is stubbed in the shape `transaction-optimistic-locking.spec.ts` uses for
 * this same service — a minimal row is enough for the final `transactionResource` load to complete,
 * and what is under test is which branch `rejectAgentChange` takes, not the revert's own mechanics
 * (`transaction-review.spec.ts` already covers reverting a value against the real schema).
 */

const ADMIN = { id: 1, name: 'Office Admin', role: 'admin' } as AuthUserRecord;

interface AuditRow {
  id: number;
  transaction_id: number;
  field: string | null;
  section: string | null;
  source: string;
  handled: boolean;
  old_value: string | null;
  new_value: string | null;
  who?: string | null;
}

interface Recorded { action: string | null; details?: string | null }

const makeService = (opts: {
  target: AuditRow;
  otherRows?: AuditRow[];
  /** What the CURRENT state of the field reads as, for the belt-and-braces check. */
  snapshotValue?: string | null;
}): { svc: TransactionsWriteService; recorded: Recorded[]; rejectionNotes: (string | null | undefined)[]; revertAttempted: () => boolean } => {
  const { target, otherRows = [], snapshotValue } = opts;
  const allAuditRows = [target, ...otherRows];
  const recorded: Recorded[] = [];
  const rejectionNotes: (string | null | undefined)[] = [];
  let revertAttempted = false;

  const txn = {
    id: target.transaction_id, trade_no: 'T-038', type: 'Residential Buying', deleted_at: null,
    price: 500000, deposit: 0, agent: 'QA', agent_user_id: 1,
    property: '1 Test St', version: 1,
  };

  const prisma = {
    transactions: {
      findFirst: async () => ({ id: target.transaction_id }), // assertExists
      findUnique: async () => txn,                            // loadResource's final read
    },
    // Reached only inside `revertAgentChange`'s own nested $transaction, which the tests that
    // expect a block must never invoke.
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => {
      revertAttempted = true;
      const tx = { transactions: { findUnique: async () => ({ type: 'Residential Buying' }), update: async () => txn } };
      return cb(tx);
    },
    // Read by `transactionResource`'s unread-message count — nothing here is under test.
    transaction_message_reads: { findFirst: async () => null },
    transaction_messages: { count: async () => 0 },
    audit_logs: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        const idCond = w.id as { gt?: number; lt?: number } | undefined;
        const result = allAuditRows.find((r) => {
          if (r.transaction_id !== w.transaction_id) return false;
          if (idCond?.gt !== undefined && !(r.id > idCond.gt)) return false;
          if (idCond?.lt !== undefined && !(r.id < idCond.lt)) return false;
          if (w.id !== undefined && typeof w.id === 'number' && r.id !== w.id) return false;
          if (w.source !== undefined && r.source !== w.source) return false;
          if (w.handled !== undefined && r.handled !== w.handled) return false;
          const fw = w.field as string | { startsWith: string } | undefined;
          if (fw !== undefined) {
            if (typeof fw === 'string' && r.field !== fw) return false;
            if (typeof fw === 'object' && !(r.field ?? '').startsWith(fw.startsWith)) return false;
          }
          return true;
        }) ?? null;
        return result;
      },
      update: async () => undefined,
    },
  } as never;

  const audit = {
    snapshot: async () => (snapshotValue === undefined
      ? {}
      : { [`${target.section}::${target.field}`]: { section: target.section, field: target.field, value: snapshotValue } }),
    record: async (_txnId: number, _actor: unknown, entry: { action: string | null; details?: string | null }) => {
      recorded.push(entry);
    },
    // Falsy: `revertAgentChange` then has no column to write and falls through unrevertable —
    // exactly like a real field with no revert mapping. What is under test is whether the
    // ATTEMPT happens at all, not whether a particular column round-trips correctly.
    columnForLabel: () => null,
  };

  const reviews = {
    recordRejection: async (input: { autoRevertNote?: string | null }) => {
      rejectionNotes.push(input.autoRevertNote);
      return {};
    },
  };

  const commission = { summarize: () => ({}) };
  const deps = [prisma, {}, audit, commission, {}, {}, {}, reviews, {}, {}] as unknown as ConstructorParameters<typeof TransactionsWriteService>;
  return { svc: new TransactionsWriteService(...deps), recorded, rejectionNotes, revertAttempted: () => revertAttempted };
};

describe('rejecting an agent change never overwrites a value that has moved on (TD-038)', () => {
  it('blocks when a NEWER change exists for the same field', async () => {
    const target: AuditRow = { id: 10, transaction_id: 1, field: 'Property', section: 'Basic', source: 'Agent', handled: false, old_value: 'A', new_value: 'B' };
    const newer: AuditRow = { id: 11, transaction_id: 1, field: 'Property', section: 'Basic', source: 'Manual', handled: true, old_value: 'B', new_value: 'C' };
    const { svc, recorded, rejectionNotes, revertAttempted: check } = makeService({ target, otherRows: [newer] });

    await svc.rejectAgentChange(ADMIN, 1, 10, 'no longer needed');

    expect(check()).toBe(false);
    expect(rejectionNotes[0]).toContain('it has been changed since');
    expect(recorded[0]?.action).toContain('not reverted');
  });

  it('blocks when an EARLIER pending change to the same field is still awaiting review', async () => {
    const earlier: AuditRow = { id: 8, transaction_id: 1, field: 'Property', section: 'Basic', source: 'Agent', handled: false, old_value: 'X', new_value: 'A' };
    const target: AuditRow = { id: 10, transaction_id: 1, field: 'Property', section: 'Basic', source: 'Agent', handled: false, old_value: 'A', new_value: 'B' };
    const { svc, rejectionNotes, revertAttempted: check } = makeService({ target, otherRows: [earlier] });

    await svc.rejectAgentChange(ADMIN, 1, 10, 'no longer needed');

    expect(check()).toBe(false);
    expect(rejectionNotes[0]).toContain('an earlier change to it is still awaiting review');
  });

  it('blocks (belt and braces) when the field no longer holds the value this change made', async () => {
    // No newer or earlier-pending audit row — the write that moved it left no trace at all.
    const target: AuditRow = { id: 10, transaction_id: 1, field: 'Property', section: 'Basic', source: 'Agent', handled: false, old_value: 'A', new_value: 'B' };
    const { svc, rejectionNotes, revertAttempted: check } = makeService({ target, snapshotValue: 'Z' });

    await svc.rejectAgentChange(ADMIN, 1, 10, 'no longer needed');

    expect(check()).toBe(false);
    expect(rejectionNotes[0]).toContain('it no longer holds the value this change made');
  });

  it('does NOT block when the current value matches what the change recorded', async () => {
    const target: AuditRow = { id: 10, transaction_id: 1, field: 'Property', section: 'Basic', source: 'Agent', handled: false, old_value: 'A', new_value: 'B' };
    const { svc, rejectionNotes, revertAttempted: check } = makeService({ target, snapshotValue: 'B' });

    await svc.rejectAgentChange(ADMIN, 1, 10, 'no longer needed');

    expect(check()).toBe(true);
    expect(rejectionNotes[0]).toBeUndefined();
  });

  it('proceeds when nothing has moved and no snapshot check applies', async () => {
    const target: AuditRow = { id: 10, transaction_id: 1, field: 'Property', section: 'Basic', source: 'Agent', handled: false, old_value: 'A', new_value: 'B' };
    const { svc, revertAttempted: check, rejectionNotes } = makeService({ target });

    await svc.rejectAgentChange(ADMIN, 1, 10, 'no longer needed');

    expect(check()).toBe(true);
    expect(rejectionNotes[0]).toBeUndefined();
  });

  it('treats a GROUPED field family as one unit — a sibling subfield changing blocks the row', async () => {
    // Rejecting "Client #1 name" must be blocked by a change to the SIBLING "Client #1 email",
    // because rejecting removes the whole client row, not just the one subfield.
    const target: AuditRow = { id: 10, transaction_id: 1, field: 'Client #1 name', section: 'Clients', source: 'Agent', handled: false, old_value: 'Jane', new_value: 'Jane Doe' };
    const sibling: AuditRow = { id: 11, transaction_id: 1, field: 'Client #1 email', section: 'Clients', source: 'Manual', handled: true, old_value: 'a@x.test', new_value: 'b@x.test' };
    const { svc, rejectionNotes, revertAttempted: check } = makeService({ target, otherRows: [sibling] });

    await svc.rejectAgentChange(ADMIN, 1, 10, 'no longer needed');

    expect(check()).toBe(false);
    expect(rejectionNotes[0]).toContain('it has been changed since');
  });

  it('does not let an unrelated field\'s history block this one', async () => {
    // A newer, unrelated field's audit entry must not be mistaken for evidence this field moved.
    const target: AuditRow = { id: 10, transaction_id: 1, field: 'Property', section: 'Basic', source: 'Agent', handled: false, old_value: 'A', new_value: 'B' };
    const unrelated: AuditRow = { id: 11, transaction_id: 1, field: 'Deposit', section: 'Financial', source: 'Manual', handled: true, old_value: '0', new_value: '5000' };
    const { svc, revertAttempted: check, rejectionNotes } = makeService({ target, otherRows: [unrelated] });

    await svc.rejectAgentChange(ADMIN, 1, 10, 'no longer needed');

    expect(check()).toBe(true);
    expect(rejectionNotes[0]).toBeUndefined();
  });
});
