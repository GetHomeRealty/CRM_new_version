import { TransactionsWriteService } from './transactions-write.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * TD-009 — the SAVE fires the trigger.
 *
 * `status-change-trigger.spec.ts` proves `ReminderSweepService.statusChanged` does the right thing
 * when it is called. It does not prove anything calls it, and a trigger nothing calls is the exact
 * shape of defect this report keeps recording: TD-116 was closed against a checklist change that
 * never reached the header buttons, TD-018 twice against checks that counted columns without
 * reading them. So this drives the real `update()` and asserts the call happens.
 *
 * WHAT IT PINS, beyond "it was called":
 *   · only NEWLY entered statuses travel — a save that leaves a deal Closed and edits its address
 *     is not a status change;
 *   · ordinary progress does not fire at all;
 *   · the previous set travels with it, since it is gone from the database by then.
 *
 * Prisma is stubbed. Everything under test happens before the stubs give out, which is why the
 * update call is allowed to throw afterwards.
 */

interface Call { txnId: number; entered: string[]; changedBy: string | null; previous: string[] }

const drive = async (stored: string[], sent: string[]): Promise<Call[]> => {
  const calls: Call[] = [];
  const now = new Date('2026-09-01T10:00:00.000Z');
  const txn = {
    id: 1838, trade_no: '201838', type: 'Residential Buying', deleted_at: null,
    price: 500_000, deposit: 0, agent: 'Sai Ramesh', agent_user_id: 7, property: '1 Test Road', version: 1,
    offer_date: null, closing_date: null, listing_expiry_date: null, comm_paid_status: null,
    admin_activities: null, activity_tracker: null, adjustments: '{}', updated_at: now,
  };
  const statusRows = stored.map((status, i) => ({ id: i + 1, transaction_id: txn.id, status }));

  const tx = {
    transactions: {
      update: async () => txn,
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => txn,
      findFirst: async () => txn,
      count: async () => 0,
    },
    transaction_statuses: {
      findMany: async () => statusRows,
      deleteMany: async () => ({ count: statusRows.length }),
      create: async () => ({ id: 99 }),
    },
    team_members: { findMany: async () => [] },
  };
  const prismaStub = {
    transactions: { findFirst: async () => txn, findUnique: async () => txn },
    transaction_statuses: { findMany: async () => statusRows },
    company_settings: { findUnique: async () => ({ feature_flags: null }) },
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  } as unknown as PrismaService;

  const audit = { snapshot: async () => ({}), record: async () => undefined, recordChanges: async () => [] };
  const reminders = {
    statusChanged: async (txnId: number, entered: string[], changedBy: string | null, previous: string[]) => {
      calls.push({ txnId, entered, changedBy, previous });
    },
    dateChanged: async () => undefined,
  };
  const lawyerReminder = { maybeRemind: async () => undefined };
  // Entering Closed for the first time runs the split upgrade, which resolves the agent.
  const people = { resolve: async () => null, resolveMany: async () => [] };
  // Closing a deal asks the review service whether anything is still outstanding.
  const reviews = { openItems: async () => [], markCorrected: async () => undefined };

  const svc = new TransactionsWriteService(
    ...([
      prismaStub, people, audit, {}, {}, {}, lawyerReminder, reviews, reminders, {}, {},
    ] as unknown as ConstructorParameters<typeof TransactionsWriteService>),
  );

  // Past the write and into the stubs' limits: the hook under test has already run.
  try {
    await svc.update(
      { id: 1, name: 'Priya Raman', role: 'admin' } as never,
      txn.id,
      { statuses: sent },
    );
  } catch { /* see above — the response-building tail runs out of stubs, well after the hook */ }

  return calls;
};

describe('a save that changes a deal’s status fires the trigger (TD-009)', () => {
  it('tells the trigger which status was entered, and what the deal was before', async () => {
    const calls = await drive(['Open'], ['Secured Firm']);

    expect(calls).toHaveLength(1);
    expect(calls[0].entered).toEqual(['Secured Firm']);
    expect(calls[0].previous).toEqual(['Open']);
    expect(calls[0].changedBy).toBe('Priya Raman');
  });

  it('does not fire on ordinary progress', async () => {
    // Secured Conditional is a step along the way, not a thing to email somebody about.
    expect(await drive(['Open'], ['Secured Conditional'])).toEqual([]);
  });

  it('does not fire again on a later save that leaves the status alone', async () => {
    // The deal is ALREADY Closed and the save re-sends it. Nothing was entered, so nothing is
    // announced — without this, every subsequent edit to a closed deal would re-notify.
    expect(await drive(['Closed'], ['Closed'])).toEqual([]);
  });

  it('passes every entered status when a save enters more than one', async () => {
    // BOTH must be legal for the type, or the save is refused before the hook is reached and this
    // proves nothing. 'Sold' is a LISTING status and the fixture is a Residential Buying, which is
    // how the first draft of this test passed for the wrong reason.
    const calls = await drive(['Secured Conditional'], ['Secured Firm', 'Closed']);

    expect(calls).toHaveLength(1);
    expect(calls[0].entered).toEqual(['Secured Firm', 'Closed']);
  });
});
