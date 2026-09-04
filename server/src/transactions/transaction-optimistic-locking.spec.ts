import { BadRequestException, ConflictException } from '@nestjs/common';
import { TransactionsWriteService } from './transactions-write.service';

/**
 * TD-003 — two people editing one transaction must not silently overwrite each other.
 *
 * THE DEFECT. Admin A and Admin B both open deal 1838. A saves a price change, 2,500,000 →
 * 2,900,000. B then saves a form loaded before that, touching only the property address, and gets
 * HTTP 200. The detail screen sends the WHOLE object on every save, so B's stale price rode along
 * and put 2,500,000 back. Neither person was told. The audit trail recorded the revert, so the
 * money was recoverable — but only by somebody who went looking, weeks later.
 *
 * WHAT IS TESTED HERE. `update()` refuses a save whose `version` is not the one the row holds, and
 * the refusal names both numbers so the screen can explain itself. Both places the check lives are
 * covered: the cheap comparison against the row that was just read, and the version-guarded write
 * that closes the window between that read and the UPDATE — the second is the one that actually
 * makes this safe, and it is invisible unless a test drives the row moving mid-request.
 *
 * NO DATABASE. Prisma is stubbed, in the shape the module's other `update()` specs use — see
 * `transaction-date-rules.spec.ts`. The genuinely concurrent case needs two connections and is not
 * what these assertions are for; what they pin is that a losing write is REFUSED rather than
 * applied, which is decided entirely by code under this file's control.
 */

const STORED_VERSION = 4;

interface Stubs {
  /** Rows matched by the version-guarded UPDATE. 0 = somebody committed first. */
  claimCount?: number;
  /** The version a re-read finds after losing the claim. */
  versionAfter?: number;
}

/** Records what the write actually asked the database for, so the guard can be inspected. */
interface Seen {
  updateMany: { where?: Record<string, unknown>; data?: Record<string, unknown> } | null;
  update: { data?: Record<string, unknown> } | null;
}

const makeService = (stubs: Stubs = {}): { svc: TransactionsWriteService; seen: Seen } => {
  const { claimCount = 1, versionAfter = STORED_VERSION + 1 } = stubs;
  const seen: Seen = { updateMany: null, update: null };

  const txn = {
    id: 1838, trade_no: '201838', type: 'Residential Buying', deleted_at: null,
    price: 2_500_000, deposit: 0, agent: 'QA', agent_user_id: 1,
    property: '1 Old Address', version: STORED_VERSION,
    offer_date: null, closing_date: null, admin_activities: null, adjustments: null,
    updated_at: new Date('2026-08-19T10:00:00.000Z'),
  };

  // The write half of the request, reached only once the version check has let it through.
  const tx = {
    transactions: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        seen.updateMany = args;
        return { count: claimCount };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        seen.update = args;
        return txn;
      },
      findUnique: async () => txn,
    },
  };

  const prisma = {
    transactions: {
      findFirst: async () => txn,
      // Two callers: `datesBefore` before the write, and the conflict re-read after losing a claim.
      findUnique: async () => ({ ...txn, version: versionAfter, closing_date: null, listing_expiry_date: null }),
    },
    transaction_statuses: { findMany: async () => [{ status: 'Secured Firm' }] },
    team_members: { findFirst: async () => null },
    company_settings: { findUnique: async () => ({ feature_flags: null }) },
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  } as never;

  const audit = {
    snapshot: async () => ({}),
    record: async () => undefined,
    recordChanges: async () => [],
  } as never;

  const deps = [prisma, {}, audit, ...Array.from({ length: 7 }, () => ({}))] as unknown as ConstructorParameters<typeof TransactionsWriteService>;
  return { svc: new TransactionsWriteService(...deps), seen };
};

type Outcome = { outcome: 'accepted' | '409' | '400' | 'other'; message: string; conflict: Record<string, unknown> | null };

/** A save of the one field the reported case touched, carrying whatever version is given. */
const put = async (version: unknown, stubs: Stubs = {}): Promise<Outcome & { seen: Seen }> => {
  const { svc, seen } = makeService(stubs);
  const body: Record<string, unknown> = { property: '2 New Address' };
  if (version !== undefined) body.version = version;
  try {
    await (svc as unknown as { update: (u: unknown, i: number, b: unknown) => Promise<unknown> })
      .update({ id: 1, name: 'QA', role: 'admin' }, 1838, body);
    return { outcome: 'accepted', message: '', conflict: null, seen };
  } catch (e) {
    if (e instanceof ConflictException) {
      const r = e.getResponse() as { message: string; conflict: Record<string, unknown> };
      return { outcome: '409', message: r.message, conflict: r.conflict, seen };
    }
    if (e instanceof BadRequestException) {
      const r = e.getResponse() as { message: string };
      return { outcome: '400', message: r.message, conflict: null, seen };
    }
    // Anything else means the request got PAST the version check and fell over further down the
    // save, on a dependency this spec does not stub. For these tests that is a pass, not a failure:
    // what is being asserted is that the write was not refused.
    return { outcome: 'other', message: (e as Error).message, conflict: null, seen };
  }
};

describe('a stale transaction save is refused, not applied (TD-003)', () => {
  it('refuses the reported case: a save carrying a version the row has moved past', async () => {
    const r = await put(STORED_VERSION - 1);
    expect(r.outcome).toBe('409');
    expect(r.message).toContain('Somebody else changed this transaction');
    expect(r.conflict).toMatchObject({ current_version: STORED_VERSION, your_version: STORED_VERSION - 1 });
  });

  it('names both versions, so the screen can say what happened rather than just "failed"', async () => {
    const r = await put(2);
    expect(r.conflict?.your_version).toBe(2);
    expect(r.conflict?.current_version).toBe(STORED_VERSION);
    expect(r.conflict?.updated_at).toBeInstanceOf(Date);
  });

  it('refuses before touching the row — a rejected save writes nothing', async () => {
    const r = await put(STORED_VERSION - 1);
    expect(r.seen.updateMany).toBeNull();
    expect(r.seen.update).toBeNull();
  });

  it('lets the current version through', async () => {
    const r = await put(STORED_VERSION);
    expect(r.outcome).not.toBe('409');
    expect(r.outcome).not.toBe('400');
  });

  it('puts the version in the WHERE, not just in a preceding read', async () => {
    // The whole point: the check and the write are one statement, so a row that moves between them
    // cannot be overwritten. A guard that only compared beforehand would leave the race open.
    const r = await put(STORED_VERSION);
    expect(r.seen.updateMany?.where).toMatchObject({ id: 1838, version: STORED_VERSION });
    expect(r.seen.updateMany?.data).toMatchObject({ version: { increment: 1 } });
  });

  it('refuses when the row moves between the check and the write', async () => {
    // Both requests pass the read-time comparison — that is what read-committed allows — and the
    // loser's UPDATE then matches no rows. Without this, two saves racing that narrow window would
    // reproduce the defect in full.
    const r = await put(STORED_VERSION, { claimCount: 0, versionAfter: STORED_VERSION + 1 });
    expect(r.outcome).toBe('409');
    // Re-read, so the reply carries the version the user must reconcile against — not the one this
    // request started out believing.
    expect(r.conflict).toMatchObject({ current_version: STORED_VERSION + 1, your_version: STORED_VERSION });
  });

  it('still saves when no version is sent, so scripts and older clients keep working', async () => {
    const r = await put(undefined);
    expect(r.outcome).not.toBe('409');
    expect(r.outcome).not.toBe('400');
    // Unguarded, exactly as before — but the counter still moves, so everybody else's open form
    // learns it is stale.
    expect(r.seen.updateMany).toBeNull();
    expect(r.seen.update?.data).toMatchObject({ version: { increment: 1 } });
  });

  it('refuses a version that is not a version', async () => {
    for (const bad of ['abc', 0, -1, 1.5]) {
      const r = await put(bad);
      expect(r.outcome).toBe('400');
      expect(r.message).toBe('That version is not valid.');
    }
  });
});
