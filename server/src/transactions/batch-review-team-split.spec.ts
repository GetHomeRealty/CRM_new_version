import { BadRequestException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { TransactionsWriteService } from './transactions-write.service';
import { batchReviewIncluded, keepStoredBatchReview, withBatchReviewVote, type BatchReviewVote } from './batch-review-votes';

/**
 * TEAM-SPLIT CLIENT REVIEW EMAIL — ONE AGENT ASKS, ANOTHER RESTRICTS, AND THE RESTRICT HOLDS.
 *
 * Madhu (2026-10-23): "Team split agents reviews - restrictions b/w agents - 1 can ask to send
 * another restrict cases must work on". Before this there was ONE tick-box per deal: whichever agent
 * saved last decided for everyone on the split, so a teammate's "don't email my client" lasted only
 * until the next save. The rule chosen: each agent has their own Send / Restrict, and the deal is
 * included only when somebody asked and NOBODY restricted.
 *
 * NO DATABASE. Prisma is stubbed in the shape `transaction-optimistic-locking.spec.ts` uses; the
 * stored tracker is one variable the stubs read and write, so a sequence of choices by different
 * people lands on the same deal exactly as it would in the table.
 */

const vote = (choice: 'send' | 'restrict', name: string, user_id: number | null = null): BatchReviewVote =>
  ({ choice, name, user_id, at: '2026-10-23T00:00:00.000Z' });

describe('the rule: somebody asked, nobody restricted', () => {
  it('one agent asking is enough when nobody objects', () => {
    expect(batchReviewIncluded(withBatchReviewVote({}, 'user:1', vote('send', 'Agent A', 1)))).toBe(true);
  });

  it('one agent restricting keeps the deal out even though another asked', () => {
    let t = withBatchReviewVote({}, 'user:1', vote('send', 'Agent A', 1));
    t = withBatchReviewVote(t, 'user:2', vote('restrict', 'Agent B', 2));
    expect(t.batch_review_email).toBe(false);
    // And the order does not matter: asking AFTER a restrict does not override it.
    let u = withBatchReviewVote({}, 'user:2', vote('restrict', 'Agent B', 2));
    u = withBatchReviewVote(u, 'user:1', vote('send', 'Agent A', 1));
    expect(u.batch_review_email).toBe(false);
  });

  it('a restrict on its own, or no choices at all, is not a request to send', () => {
    expect(withBatchReviewVote({}, 'user:2', vote('restrict', 'Agent B', 2)).batch_review_email).toBe(false);
    const cleared = withBatchReviewVote(withBatchReviewVote({}, 'user:1', vote('send', 'Agent A', 1)), 'user:1', null);
    expect(cleared.batch_review_email).toBe(false);
  });

  it('only the agent who restricted can lift it, by withdrawing their own choice', () => {
    let t = withBatchReviewVote({}, 'user:1', vote('send', 'Agent A', 1));
    t = withBatchReviewVote(t, 'user:2', vote('restrict', 'Agent B', 2));
    // Agent A sending again changes nothing.
    t = withBatchReviewVote(t, 'user:1', vote('send', 'Agent A', 1));
    expect(t.batch_review_email).toBe(false);
    t = withBatchReviewVote(t, 'user:2', null);
    expect(t.batch_review_email).toBe(true);
  });

  it('a deal ticked before per-agent choices keeps that request, and a later restrict still wins', () => {
    const legacy = { batch_review_email: true };
    expect(batchReviewIncluded(legacy)).toBe(true);
    const t = withBatchReviewVote(legacy, 'user:2', vote('restrict', 'Agent B', 2));
    expect(t.batch_review_email).toBe(false);
    expect((t.batch_review_votes as Record<string, BatchReviewVote>).office.choice).toBe('send');
  });

  it('a whole-form save cannot carry a tick past a restrict', () => {
    const stored = withBatchReviewVote(withBatchReviewVote({}, 'user:1', vote('send', 'Agent A', 1)), 'user:2', vote('restrict', 'Agent B', 2));
    const kept = keepStoredBatchReview(stored, { batch_review_email: true, docs_cleared: 'Yes' });
    expect(kept.batch_review_email).toBe(false);
    expect(kept.batch_review_votes).toEqual(stored.batch_review_votes);
    expect(kept.docs_cleared).toBe('Yes');
    // Silence stays "not included" (TD-094): a deal nobody chose for cannot be ticked by a save.
    expect(keepStoredBatchReview({}, { batch_review_email: true }).batch_review_email).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

interface Deal {
  tracker: Record<string, unknown>;
  statuses: string[];
  /** team_members rows: who is on the split, by user id. */
  team: number[];
  audits: Record<string, unknown>[];
  /** The tracker a whole-form save asked the database to write. */
  savedTracker: Record<string, unknown> | null;
}

const OWNER = { id: 1, name: 'Agent A', role: 'agent' };
const TEAMMATE = { id: 2, name: 'Agent B', role: 'agent' };
const OUTSIDER = { id: 3, name: 'Agent C', role: 'agent' };
const ADMIN = { id: 9, name: 'Office Admin', role: 'admin' };
const DOCS = { id: 8, name: 'Coordinator', role: 'documentation' };

const makeDeal = (over: Partial<Deal> = {}): Deal => ({ tracker: {}, statuses: ['Secured Firm'], team: [1, 2], audits: [], savedTracker: null, ...over });

const makeService = (deal: Deal): TransactionsWriteService => {
  const row = () => ({
    id: 77, trade_no: '200077', type: 'Residential Buying', deleted_at: null, price: 500_000, deposit: 0,
    agent: 'Agent A', agent_user_id: 1, version: 3, offer_date: null, closing_date: null,
    admin_activities: null, adjustments: null, activity_tracker: JSON.stringify(deal.tracker),
    updated_at: new Date('2026-10-23T10:00:00.000Z'),
  });
  const tx = {
    $queryRaw: async () => [{ activity_tracker: JSON.stringify(deal.tracker) }],
    transactions: {
      update: async (args: { data: Record<string, unknown> }) => {
        const at = args.data.activity_tracker;
        if (typeof at === 'string') {
          // `setBatchReviewChoice` writes the tracker alone; a whole-form save writes it with the rest.
          if (Object.keys(args.data).length === 1) deal.tracker = JSON.parse(at);
          else deal.savedTracker = JSON.parse(at);
        }
        return row();
      },
      updateMany: async (args: { data: Record<string, unknown> }) => {
        if (typeof args.data.activity_tracker === 'string') deal.savedTracker = JSON.parse(args.data.activity_tracker);
        return { count: 1 };
      },
      findUnique: async () => row(),
    },
  };
  const prisma = {
    transactions: { findFirst: async () => row(), findUnique: async () => ({ ...row(), listing_expiry_date: null }) },
    transaction_statuses: { findMany: async () => deal.statuses.map((status) => ({ status })) },
    team_members: {
      findFirst: async (args: { where: { access?: string; OR?: { user_id?: number }[] } }) => {
        const id = args.where.OR?.find((o) => o.user_id !== undefined)?.user_id;
        // Agent B is on the split with Documents access only — not an editor of the deal.
        if (args.where.access === 'full') return id === 1 ? { id: 1 } : null;
        return id !== undefined && deal.team.includes(id) ? { id } : null;
      },
    },
    company_settings: { findUnique: async () => ({ feature_flags: null }) },
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  } as never;
  const audit = {
    snapshot: async () => ({}),
    record: async (_id: number, _u: unknown, a: Record<string, unknown>) => { deal.audits.push(a); },
    recordChanges: async () => [],
  } as never;
  const people = { resolve: async () => ({ id: 1 }) };
  const deps = [prisma, people, audit, ...Array.from({ length: 8 }, () => ({}))] as unknown as ConstructorParameters<typeof TransactionsWriteService>;
  const svc = new TransactionsWriteService(...deps);
  // The full deal resource needs the commission engine; what is asserted here is the stored tracker.
  (svc as unknown as { loadResource: () => Promise<unknown> }).loadResource = async () => ({ data: { activity_tracker: deal.tracker } });
  return svc;
};

const choose = (svc: TransactionsWriteService, user: unknown, choice: unknown) =>
  svc.setBatchReviewChoice(user as never, 77, choice);

describe('each agent on a team split has their own say (setBatchReviewChoice)', () => {
  it('the reported case: Agent A asks to send, Agent B restricts — nothing is included', async () => {
    const deal = makeDeal();
    const svc = makeService(deal);
    await choose(svc, OWNER, 'send');
    expect(deal.tracker.batch_review_email).toBe(true);
    await choose(svc, TEAMMATE, 'restrict');
    expect(deal.tracker.batch_review_email).toBe(false);
    expect(deal.tracker.batch_review_votes).toMatchObject({
      'user:1': { choice: 'send', name: 'Agent A', user_id: 1 },
      'user:2': { choice: 'restrict', name: 'Agent B', user_id: 2 },
    });
    // Agent A cannot get round it by asking again, and neither can the office.
    await choose(svc, OWNER, 'send');
    await choose(svc, ADMIN, 'send');
    expect(deal.tracker.batch_review_email).toBe(false);
    // Each choice is on the deal's history, with who made it.
    expect(deal.audits.map((a) => a.new)).toEqual(['Send', 'Restrict', 'Send', 'Send']);
    expect(deal.audits[1]).toMatchObject({ field: 'Client review email', source: 'Agent', old: 'No choice' });
  });

  it('Agent B lifting their restrict lets Agent A\'s request through', async () => {
    const deal = makeDeal();
    const svc = makeService(deal);
    await choose(svc, OWNER, 'send');
    await choose(svc, TEAMMATE, 'restrict');
    await choose(svc, TEAMMATE, null);
    expect(deal.tracker.batch_review_email).toBe(true);
  });

  it('an agent answers only for themself, keyed by their own account', async () => {
    const deal = makeDeal();
    const svc = makeService(deal);
    await choose(svc, TEAMMATE, 'restrict');
    expect(Object.keys(deal.tracker.batch_review_votes as object)).toEqual(['user:2']);
    await choose(svc, ADMIN, 'send');
    expect(Object.keys(deal.tracker.batch_review_votes as object).sort()).toEqual(['office', 'user:2']);
  });

  it('an agent who is not on the deal has no say', async () => {
    const svc = makeService(makeDeal());
    await expect(choose(svc, OUTSIDER, 'restrict')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Documentation has no say, as before', async () => {
    const svc = makeService(makeDeal());
    await expect(choose(svc, DOCS, 'send')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a DFT deal takes no choice — no review email goes out for it', async () => {
    const svc = makeService(makeDeal({ statuses: ['DFT'] }));
    await expect(choose(svc, OWNER, 'send')).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('only Send, Restrict or withdrawing are accepted', async () => {
    const svc = makeService(makeDeal());
    for (const bad of [undefined, true, 'yes', 1]) {
      await expect(choose(svc, OWNER, bad)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe('a whole-form save cannot undo a restrict', () => {
  const restricted = (): Record<string, unknown> =>
    withBatchReviewVote(withBatchReviewVote({}, 'user:1', vote('send', 'Agent A', 1)), 'user:2', vote('restrict', 'Agent B', 2));

  const save = async (user: unknown, deal: Deal, tracker: Record<string, unknown>) => {
    const svc = makeService(deal);
    try {
      await (svc as unknown as { update: (u: unknown, i: number, b: unknown) => Promise<unknown> })
        .update(user, 77, { version: 3, activity_tracker: tracker });
    } catch {
      // Past the write, `update()` reaches dependencies this spec does not stub. What is asserted is
      // the tracker the write asked for, which is captured before that point.
    }
  };

  it('the office ticking the old deal-level box keeps the restrict', async () => {
    const deal = makeDeal({ tracker: restricted() });
    await save(ADMIN, deal, { batch_review_email: true, docs_cleared: 'Yes' });
    expect(deal.savedTracker).not.toBeNull();
    expect(deal.savedTracker?.batch_review_email).toBe(false);
    expect(deal.savedTracker?.batch_review_votes).toEqual(deal.tracker.batch_review_votes);
    expect(deal.savedTracker?.docs_cleared).toBe('Yes');
  });

  it('the owning agent\'s save keeps the restrict too', async () => {
    const deal = makeDeal({ tracker: restricted() });
    await save(OWNER, deal, { batch_review_email: true });
    expect(deal.savedTracker?.batch_review_email).toBe(false);
    expect(deal.savedTracker?.batch_review_votes).toEqual(deal.tracker.batch_review_votes);
  });
});
